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
	"sync"
	"sync/atomic"
	"time"
)

const (
	geminiAPIBase          = "https://generativelanguage.googleapis.com/v1beta/models"
	geminiBatchSize        = 200
	geminiConcurrency      = 4
	geminiMinSubdivideSize = 10 // stop subdividing below this cue count
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
			Timeout: 8 * time.Minute,
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

func isTransientError(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "deadline exceeded") ||
		strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "status 503") ||
		strings.Contains(msg, "status 429")
}

func isBlockedError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "blocked")
}

type batchResult struct {
	cues         []SubtitleCue
	err          error
	blockedCount int
}

func (g *GeminiTranslator) Translate(ctx context.Context, cues []SubtitleCue, opts TranslateOptions, updateProgress func(float64)) ([]SubtitleCue, error) {
	if g.apiKey == "" {
		return nil, fmt.Errorf("Gemini API key not configured")
	}

	model := g.currentModel()
	systemPrompt := GetSystemPrompt(opts.Preset, opts.SourceLang, opts.TargetLang)
	if opts.Preset == "custom" && opts.CustomPrompt != "" {
		systemPrompt += "\n\nUser instructions: " + opts.CustomPrompt
	}

	// For small cue counts, try single request with subdivision support
	if len(cues) <= geminiBatchSize {
		log.Printf("[gemini] using model: %s, translating %d cues in single request", model, len(cues))
		updateProgress(0.1)

		translated, blockedCount := g.translateWithSubdivision(ctx, cues, systemPrompt, model, 0, "single-request")
		updateProgress(1.0)
		if blockedCount > 0 {
			log.Printf("[gemini] WARNING: %d/%d cues blocked in single-request mode, kept original text", blockedCount, len(cues))
		}
		log.Printf("[gemini] translation complete: %d cues (single request, %d blocked)", len(translated), blockedCount)
		return translated, nil
	}

	// Batch mode — concurrent execution with subdivision on block
	totalBatches := (len(cues) + geminiBatchSize - 1) / geminiBatchSize
	log.Printf("[gemini] using model: %s, translating %d cues in %d batches (%d per batch, %d concurrent)",
		model, len(cues), totalBatches, geminiBatchSize, geminiConcurrency)

	results := make([]batchResult, totalBatches)
	var completedBatches atomic.Int32
	sem := make(chan struct{}, geminiConcurrency)
	var wg sync.WaitGroup

	for i := 0; i < len(cues); i += geminiBatchSize {
		end := i + geminiBatchSize
		if end > len(cues) {
			end = len(cues)
		}
		batchIdx := i / geminiBatchSize
		batch := cues[i:end]

		wg.Add(1)
		sem <- struct{}{} // acquire concurrency slot

		go func(idx int, batch []SubtitleCue) {
			defer wg.Done()
			defer func() { <-sem }() // release slot

			batchNum := idx + 1
			batchLabel := fmt.Sprintf("batch %d/%d", batchNum, totalBatches)
			log.Printf("[gemini] %s (%d cues) started", batchLabel, len(batch))

			translated, blockedCount := g.translateWithSubdivision(ctx, batch, systemPrompt, model, 0, batchLabel)
			results[idx] = batchResult{cues: translated, blockedCount: blockedCount}

			done := completedBatches.Add(1)
			updateProgress(float64(done) / float64(totalBatches))
			log.Printf("[gemini] %s completed (%d blocked)", batchLabel, blockedCount)
		}(batchIdx, batch)
	}

	wg.Wait()

	// Merge results in order
	var result []SubtitleCue
	totalBlockedCues := 0
	for _, r := range results {
		if r.err != nil {
			return nil, r.err
		}
		totalBlockedCues += r.blockedCount
		result = append(result, r.cues...)
	}

	if totalBlockedCues > 0 {
		log.Printf("[gemini] WARNING: %d/%d cues were blocked, kept original text", totalBlockedCues, len(cues))
	}

	updateProgress(1.0)
	log.Printf("[gemini] translation complete: %d cues (batch mode, %d batches, %d concurrent, %d blocked cues)",
		len(result), totalBatches, geminiConcurrency, totalBlockedCues)
	return result, nil
}

// translateWithSubdivision attempts to translate cues, and on block recursively
// splits the batch in half until sub-batches succeed or reach minimum size.
// Returns translated cues (always same count as input) and count of blocked cues.
func (g *GeminiTranslator) translateWithSubdivision(
	ctx context.Context,
	cues []SubtitleCue,
	systemPrompt string,
	model string,
	depth int,
	label string,
) ([]SubtitleCue, int) {
	// Try translating the full batch (with transient-error retry)
	translated, err := g.callGeminiAPI(ctx, cues, systemPrompt, model)
	if err != nil && isTransientError(err) {
		log.Printf("[gemini] %s failed (%v), retrying after 5s... (depth=%d)", label, err, depth)
		time.Sleep(5 * time.Second)
		translated, err = g.callGeminiAPI(ctx, cues, systemPrompt, model)
	}

	// Success — return translated cues
	if err == nil {
		if depth > 0 {
			log.Printf("[gemini] %s translated successfully (%d cues, depth=%d)", label, len(translated), depth)
		}
		return translated, 0
	}

	// Non-blocked error — keep original text to avoid data loss
	if !isBlockedError(err) {
		log.Printf("[gemini] %s failed: %v (depth=%d), keeping original text", label, err, depth)
		return cues, len(cues)
	}

	// Blocked — check if we can subdivide further
	if len(cues) <= geminiMinSubdivideSize {
		log.Printf("[gemini] %s blocked at minimum size (%d cues, depth=%d), keeping original text", label, len(cues), depth)
		return cues, len(cues)
	}

	// Split in half and recurse sequentially
	mid := len(cues) / 2
	log.Printf("[gemini] %s blocked (%d cues, depth=%d), subdividing into [0:%d] and [%d:%d]",
		label, len(cues), depth, mid, mid, len(cues))

	leftLabel := fmt.Sprintf("%s-L%d", label, depth+1)
	rightLabel := fmt.Sprintf("%s-R%d", label, depth+1)

	leftTranslated, leftBlocked := g.translateWithSubdivision(ctx, cues[:mid], systemPrompt, model, depth+1, leftLabel)
	rightTranslated, rightBlocked := g.translateWithSubdivision(ctx, cues[mid:], systemPrompt, model, depth+1, rightLabel)

	// Merge results in order
	merged := make([]SubtitleCue, 0, len(cues))
	merged = append(merged, leftTranslated...)
	merged = append(merged, rightTranslated...)

	return merged, leftBlocked + rightBlocked
}

// callGeminiAPI sends cues to Gemini and returns translated cues.
func (g *GeminiTranslator) callGeminiAPI(ctx context.Context, cues []SubtitleCue, systemPrompt string, model string) ([]SubtitleCue, error) {
	// Build user prompt
	var userPrompt strings.Builder
	userPrompt.WriteString("Translate the following subtitle cues. Return ONLY a JSON array with the translated text for each cue, maintaining the same order and count.\n\n")
	userPrompt.WriteString("Input cues:\n")

	for _, cue := range cues {
		userPrompt.WriteString(fmt.Sprintf("[%d] %s\n", cue.Index, cue.Text))
	}

	userPrompt.WriteString(fmt.Sprintf("\nReturn exactly %d translations as a JSON array of strings. Example: [\"translated line 1\", \"translated line 2\", ...]", len(cues)))

	// Build request
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
			"temperature":      0.3,
			"responseMimeType": "application/json",
		},
		"safetySettings": []map[string]string{
			{"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
			{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
			{"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
			{"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
			{"category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "BLOCK_NONE"},
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
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		PromptFeedback struct {
			BlockReason   string `json:"blockReason"`
			SafetyRatings []struct {
				Category    string `json:"category"`
				Probability string `json:"probability"`
			} `json:"safetyRatings"`
		} `json:"promptFeedback"`
	}

	if err := json.Unmarshal(body, &geminiResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if len(geminiResp.Candidates) == 0 || len(geminiResp.Candidates[0].Content.Parts) == 0 {
		log.Printf("[gemini] empty response body: %s", string(body))
		if geminiResp.PromptFeedback.BlockReason != "" {
			return nil, fmt.Errorf("Gemini blocked: %s", geminiResp.PromptFeedback.BlockReason)
		}
		return nil, fmt.Errorf("empty Gemini response")
	}

	if fr := geminiResp.Candidates[0].FinishReason; fr != "" && fr != "STOP" {
		log.Printf("[gemini] WARNING: finishReason=%s", fr)
	}

	// Parse the JSON array of translated strings
	translatedText := geminiResp.Candidates[0].Content.Parts[0].Text
	// Gemini sometimes returns ASS-style \N (line break) which is invalid JSON escape
	translatedText = strings.ReplaceAll(translatedText, `\N`, `\n`)
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

	if len(translations) != len(cues) {
		log.Printf("[gemini] WARNING: expected %d translations, got %d", len(cues), len(translations))
	}

	// Map translations back to cues
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
			result[i].Text = cue.Text
			emptyCount++
		}
	}

	if emptyCount > 0 {
		log.Printf("[gemini] WARNING: %d/%d translations were empty, kept original text", emptyCount, len(cues))
	}

	return result, nil
}
