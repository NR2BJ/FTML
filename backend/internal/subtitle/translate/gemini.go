package translate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	geminiAPIBase = "https://generativelanguage.googleapis.com/v1beta/models"
	batchSize     = 50 // number of cues per API call
)

// ModelResolver returns the current Gemini model from settings
type ModelResolver func() string

// GeminiTranslator translates subtitles using Google Gemini API
type GeminiTranslator struct {
	apiKey        string
	modelResolver ModelResolver // dynamically resolves model from DB
	httpClient    *http.Client
}

func NewGeminiTranslator(apiKey string, modelResolver ModelResolver) *GeminiTranslator {
	return &GeminiTranslator{
		apiKey:        apiKey,
		modelResolver: modelResolver,
		httpClient: &http.Client{
			Timeout: 2 * time.Minute,
		},
	}
}

func (g *GeminiTranslator) currentModel() string {
	if g.modelResolver != nil {
		if m := g.modelResolver(); m != "" {
			return m
		}
	}
	return "gemini-2.0-flash"
}

func (g *GeminiTranslator) Name() string {
	return "gemini"
}

func (g *GeminiTranslator) Translate(ctx context.Context, cues []SubtitleCue, opts TranslateOptions, updateProgress func(float64)) ([]SubtitleCue, error) {
	if g.apiKey == "" {
		return nil, fmt.Errorf("Gemini API key not configured")
	}

	model := g.currentModel()
	log.Printf("[gemini] using model: %s", model)

	systemPrompt := GetSystemPrompt(opts.Preset, opts.SourceLang, opts.TargetLang)
	if opts.Preset == "custom" && opts.CustomPrompt != "" {
		systemPrompt += "\n\nUser instructions: " + opts.CustomPrompt
	}

	// Process in batches
	var result []SubtitleCue
	totalBatches := (len(cues) + batchSize - 1) / batchSize

	for i := 0; i < len(cues); i += batchSize {
		end := i + batchSize
		if end > len(cues) {
			end = len(cues)
		}
		batch := cues[i:end]
		batchNum := i/batchSize + 1

		progress := float64(i) / float64(len(cues))
		updateProgress(progress)

		log.Printf("[gemini] translating batch %d/%d (%d cues)", batchNum, totalBatches, len(batch))

		translated, err := g.translateBatch(ctx, batch, systemPrompt, model)
		if err != nil {
			return nil, fmt.Errorf("batch %d: %w", batchNum, err)
		}

		result = append(result, translated...)
	}

	return result, nil
}

func (g *GeminiTranslator) translateBatch(ctx context.Context, cues []SubtitleCue, systemPrompt string, model string) ([]SubtitleCue, error) {
	// Build the prompt with numbered cues
	var userPrompt strings.Builder
	userPrompt.WriteString("Translate the following subtitle cues. Return ONLY a JSON array with the translated text for each cue, maintaining the same order and count.\n\n")
	userPrompt.WriteString("Input cues:\n")

	for _, cue := range cues {
		userPrompt.WriteString(fmt.Sprintf("[%d] %s\n", cue.Index, cue.Text))
	}

	userPrompt.WriteString(fmt.Sprintf("\nReturn exactly %d translations as a JSON array of strings. Example: [\"translated line 1\", \"translated line 2\", ...]", len(cues)))

	// Build Gemini API request
	reqBody := map[string]interface{}{
		"system_instruction": map[string]interface{}{
			"parts": []map[string]string{
				{"text": systemPrompt},
			},
		},
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]string{
					{"text": userPrompt.String()},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"temperature":     0.3,
			"responseMimeType": "application/json",
		},
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/%s:generateContent", geminiAPIBase, model)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-goog-api-key", g.apiKey)

	resp, err := g.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("Gemini API request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Gemini API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Parse response
	var geminiResp struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}

	if err := json.Unmarshal(body, &geminiResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if len(geminiResp.Candidates) == 0 || len(geminiResp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("empty Gemini response")
	}

	// Parse the JSON array of translated strings
	translatedText := geminiResp.Candidates[0].Content.Parts[0].Text
	var translations []string
	if err := json.Unmarshal([]byte(translatedText), &translations); err != nil {
		// Try to extract JSON from response text
		start := strings.Index(translatedText, "[")
		end := strings.LastIndex(translatedText, "]")
		if start >= 0 && end > start {
			if err2 := json.Unmarshal([]byte(translatedText[start:end+1]), &translations); err2 != nil {
				return nil, fmt.Errorf("parse translations: %w (raw: %s)", err, translatedText)
			}
		} else {
			return nil, fmt.Errorf("parse translations: %w (raw: %s)", err, translatedText)
		}
	}

	// Map translations back to cues, defending against empty translations
	result := make([]SubtitleCue, len(cues))
	emptyCount := 0
	for i, cue := range cues {
		result[i] = SubtitleCue{
			Index: cue.Index,
			Start: cue.Start,
			End:   cue.End,
		}
		if i < len(translations) && strings.TrimSpace(translations[i]) != "" {
			result[i].Text = translations[i]
		} else {
			// Fallback to original text if translation is empty
			result[i].Text = cue.Text
			emptyCount++
		}
	}

	if emptyCount > 0 {
		log.Printf("[gemini] WARNING: %d/%d translations were empty, kept original text", emptyCount, len(cues))
	}

	return result, nil
}
