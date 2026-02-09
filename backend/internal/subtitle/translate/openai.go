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

const openAIChatURL = "https://api.openai.com/v1/chat/completions"

// OpenAITranslator translates subtitles using OpenAI Chat API
type OpenAITranslator struct {
	apiKey     string
	httpClient *http.Client
}

func NewOpenAITranslator(apiKey string) *OpenAITranslator {
	return &OpenAITranslator{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 5 * time.Minute,
		},
	}
}

func (o *OpenAITranslator) Name() string {
	return "openai"
}

func (o *OpenAITranslator) Translate(ctx context.Context, cues []SubtitleCue, opts TranslateOptions, updateProgress func(float64)) ([]SubtitleCue, error) {
	if o.apiKey == "" {
		return nil, fmt.Errorf("OpenAI API key not configured")
	}

	systemPrompt := GetSystemPrompt(opts.Preset, opts.SourceLang, opts.TargetLang)
	if opts.Preset == "custom" && opts.CustomPrompt != "" {
		systemPrompt += "\n\nUser instructions: " + opts.CustomPrompt
	}

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

		log.Printf("[openai-translate] translating batch %d/%d (%d cues)", batchNum, totalBatches, len(batch))

		translated, err := o.translateBatch(ctx, batch, systemPrompt)
		if err != nil {
			return nil, fmt.Errorf("batch %d: %w", batchNum, err)
		}

		result = append(result, translated...)
	}

	return result, nil
}

func (o *OpenAITranslator) translateBatch(ctx context.Context, cues []SubtitleCue, systemPrompt string) ([]SubtitleCue, error) {
	var userPrompt strings.Builder
	userPrompt.WriteString("Translate the following subtitle cues. Return ONLY a JSON array with the translated text for each cue, maintaining the same order and count.\n\n")
	userPrompt.WriteString("Input cues:\n")

	for _, cue := range cues {
		userPrompt.WriteString(fmt.Sprintf("[%d] %s\n", cue.Index, cue.Text))
	}

	userPrompt.WriteString(fmt.Sprintf("\nReturn exactly %d translations as a JSON array of strings.", len(cues)))

	reqBody := map[string]interface{}{
		"model": "gpt-4o-mini",
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt.String()},
		},
		"temperature": 0.3,
		"response_format": map[string]string{
			"type": "json_object",
		},
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", openAIChatURL, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+o.apiKey)

	resp, err := o.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("OpenAI API request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("OpenAI API error (status %d): %s", resp.StatusCode, string(body))
	}

	var chatResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.Unmarshal(body, &chatResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if len(chatResp.Choices) == 0 {
		return nil, fmt.Errorf("empty OpenAI response")
	}

	content := chatResp.Choices[0].Message.Content

	// Parse JSON response - could be {"translations": [...]} or just [...]
	var translations []string

	// Try direct array first
	if err := json.Unmarshal([]byte(content), &translations); err != nil {
		// Try object with translations field
		var wrapped map[string]json.RawMessage
		if err2 := json.Unmarshal([]byte(content), &wrapped); err2 == nil {
			for _, v := range wrapped {
				if err3 := json.Unmarshal(v, &translations); err3 == nil {
					break
				}
			}
		}
		if translations == nil {
			// Try to extract JSON array from content
			start := strings.Index(content, "[")
			end := strings.LastIndex(content, "]")
			if start >= 0 && end > start {
				json.Unmarshal([]byte(content[start:end+1]), &translations)
			}
		}
		if translations == nil {
			return nil, fmt.Errorf("parse translations from OpenAI: %s", content)
		}
	}

	result := make([]SubtitleCue, len(cues))
	for i, cue := range cues {
		result[i] = SubtitleCue{
			Index: cue.Index,
			Start: cue.Start,
			End:   cue.End,
		}
		if i < len(translations) {
			result[i].Text = translations[i]
		} else {
			result[i].Text = cue.Text
		}
	}

	return result, nil
}
