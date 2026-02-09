package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const deeplBatchSize = 50 // DeepL API limit: max 50 texts per request

const deeplAPIURL = "https://api-free.deepl.com/v2/translate"

// DeepLTranslator translates subtitles using the DeepL API
type DeepLTranslator struct {
	apiKey     string
	httpClient *http.Client
}

func NewDeepLTranslator(apiKey string) *DeepLTranslator {
	return &DeepLTranslator{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 1 * time.Minute,
		},
	}
}

func (d *DeepLTranslator) Name() string {
	return "deepl"
}

func (d *DeepLTranslator) Translate(ctx context.Context, cues []SubtitleCue, opts TranslateOptions, updateProgress func(float64)) ([]SubtitleCue, error) {
	if d.apiKey == "" {
		return nil, fmt.Errorf("DeepL API key not configured")
	}

	totalBatches := (len(cues) + deeplBatchSize - 1) / deeplBatchSize
	log.Printf("[deepl] translating %d cues in %d batches (%d per batch, %d concurrent)",
		len(cues), totalBatches, deeplBatchSize, concurrency)

	type deeplResult struct {
		cues []SubtitleCue
		err  error
	}

	results := make([]deeplResult, totalBatches)
	var completedBatches atomic.Int32
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for i := 0; i < len(cues); i += deeplBatchSize {
		end := i + deeplBatchSize
		if end > len(cues) {
			end = len(cues)
		}
		batchIdx := i / deeplBatchSize
		batch := cues[i:end]

		wg.Add(1)
		sem <- struct{}{}

		go func(idx int, batch []SubtitleCue) {
			defer wg.Done()
			defer func() { <-sem }()

			batchNum := idx + 1
			log.Printf("[deepl] batch %d/%d (%d cues) started", batchNum, totalBatches, len(batch))

			translated, err := d.translateBatch(ctx, batch, opts)
			if err != nil {
				if isTransientError(err) {
					log.Printf("[deepl] batch %d failed (%v), retrying after 5s...", batchNum, err)
					time.Sleep(5 * time.Second)
					translated, err = d.translateBatch(ctx, batch, opts)
				}
			}

			if err != nil {
				results[idx] = deeplResult{err: fmt.Errorf("batch %d: %w", batchNum, err)}
			} else {
				results[idx] = deeplResult{cues: translated}
			}

			done := completedBatches.Add(1)
			updateProgress(float64(done) / float64(totalBatches))
			log.Printf("[deepl] batch %d/%d completed", batchNum, totalBatches)
		}(batchIdx, batch)
	}

	wg.Wait()

	var result []SubtitleCue
	for _, r := range results {
		if r.err != nil {
			return nil, r.err
		}
		result = append(result, r.cues...)
	}

	log.Printf("[deepl] translation complete: %d cues (%d batches)", len(result), totalBatches)
	return result, nil
}

func (d *DeepLTranslator) translateBatch(ctx context.Context, cues []SubtitleCue, opts TranslateOptions) ([]SubtitleCue, error) {
	// Build form data
	form := url.Values{}
	for _, cue := range cues {
		form.Add("text", cue.Text)
	}
	form.Set("target_lang", deeplLangCode(opts.TargetLang))
	if opts.SourceLang != "" && opts.SourceLang != "auto" {
		form.Set("source_lang", deeplLangCode(opts.SourceLang))
	}

	// Map preset to DeepL formality
	switch opts.Preset {
	case "documentary":
		form.Set("formality", "more")
	case "anime":
		form.Set("formality", "less")
	case "movie":
		form.Set("formality", "default")
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", deeplAPIURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	httpReq.Header.Set("Authorization", "DeepL-Auth-Key "+d.apiKey)

	resp, err := d.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("DeepL API request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DeepL API error (status %d): %s", resp.StatusCode, string(body))
	}

	var deeplResp struct {
		Translations []struct {
			Text string `json:"text"`
		} `json:"translations"`
	}

	if err := json.Unmarshal(body, &deeplResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	result := make([]SubtitleCue, len(cues))
	for i, cue := range cues {
		result[i] = SubtitleCue{
			Index: cue.Index,
			Start: cue.Start,
			End:   cue.End,
		}
		if i < len(deeplResp.Translations) {
			result[i].Text = deeplResp.Translations[i].Text
		} else {
			result[i].Text = cue.Text
		}
	}

	return result, nil
}

// deeplLangCode converts ISO 639-1 codes to DeepL format
func deeplLangCode(code string) string {
	mapping := map[string]string{
		"ko": "KO",
		"en": "EN",
		"ja": "JA",
		"zh": "ZH",
		"de": "DE",
		"fr": "FR",
		"es": "ES",
		"it": "IT",
		"pt": "PT-BR",
		"ru": "RU",
		"nl": "NL",
		"pl": "PL",
	}
	if mapped, ok := mapping[code]; ok {
		return mapped
	}
	return strings.ToUpper(code)
}
