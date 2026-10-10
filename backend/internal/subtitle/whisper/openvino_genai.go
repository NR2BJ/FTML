package whisper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// OpenVINOGenAIClient talks to the OpenVINO GenAI WhisperPipeline FastAPI server
type OpenVINOGenAIClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewOpenVINOGenAIClient creates a client for the OpenVINO GenAI whisper server
func NewOpenVINOGenAIClient(baseURL string) *OpenVINOGenAIClient {
	return &OpenVINOGenAIClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 2 * time.Hour, // Qwen 최초 변환과 긴 영상도 작업 취소로 중단할 수 있다.
		},
	}
}

func (c *OpenVINOGenAIClient) Name() string {
	return "openvino-genai"
}

// Transcribe sends an audio file to the OpenVINO GenAI server and returns VTT
func (c *OpenVINOGenAIClient) Transcribe(ctx context.Context, req TranscribeRequest, updateProgress func(float64)) (*TranscribeResult, error) {
	// Step 1: Extract audio from video using FFmpeg (WAV 16kHz mono)
	updateProgress(0.05)
	audioPath, err := extractAudio(ctx, req.FilePath, req.AudioTrack)
	if err != nil {
		return nil, fmt.Errorf("extract audio: %w", err)
	}
	defer os.Remove(audioPath)

	updateProgress(0.1)

	// Step 2: Send to OpenVINO GenAI server with retries
	result, err := c.sendWithRetry(ctx, audioPath, req.Language, updateProgress, req)
	if err != nil {
		return nil, err
	}

	return result, nil
}

func (c *OpenVINOGenAIClient) sendWithRetry(ctx context.Context, audioPath, language string, updateProgress func(float64), options ...TranscribeRequest) (*TranscribeResult, error) {
	const maxRetries = 3
	var lastErr error

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(1<<uint(attempt)) * time.Second
			log.Printf("[openvino-genai] retry %d/%d after %v", attempt, maxRetries, backoff)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		result, err := c.doSend(ctx, audioPath, language, updateProgress, options...)
		if err == nil {
			return result, nil
		}

		lastErr = err

		if isOOMError(err.Error()) {
			return nil, fmt.Errorf("GPU out of memory — try a smaller model: %w", err)
		}

		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		if !isRetryableError(0, err) {
			return nil, err
		}

		log.Printf("[openvino-genai] transient error (attempt %d/%d): %v", attempt+1, maxRetries+1, err)
	}

	return nil, fmt.Errorf("openvino-genai server failed after %d attempts: %w", maxRetries+1, lastErr)
}

func (c *OpenVINOGenAIClient) doSend(ctx context.Context, audioPath, language string, updateProgress func(float64), options ...TranscribeRequest) (*TranscribeResult, error) {
	audioFile, err := os.Open(audioPath)
	if err != nil {
		return nil, fmt.Errorf("open audio: %w", err)
	}
	defer audioFile.Close()

	pipeReader, pipeWriter := io.Pipe()
	defer pipeReader.Close()
	writer := multipart.NewWriter(pipeWriter)

	go func() {
		defer pipeWriter.Close()
		defer writer.Close()

		part, err := writer.CreateFormFile("file", filepath.Base(audioPath))
		if err != nil {
			pipeWriter.CloseWithError(fmt.Errorf("create form file: %w", err))
			return
		}
		if _, err := io.Copy(part, audioFile); err != nil {
			pipeWriter.CloseWithError(fmt.Errorf("copy audio data: %w", err))
			return
		}

		if err := writer.WriteField("response_format", "ftml_json"); err != nil {
			pipeWriter.CloseWithError(fmt.Errorf("write response format: %w", err))
			return
		}
		if language != "" && language != "auto" {
			if err := writer.WriteField("language", language); err != nil {
				pipeWriter.CloseWithError(fmt.Errorf("write language: %w", err))
				return
			}
		}
		if len(options) > 0 {
			if options[0].ObserveSpeech {
				if err := writer.WriteField("observe_speech", "true"); err != nil {
					pipeWriter.CloseWithError(err)
					return
				}
			}
			for key, value := range map[string]string{"model": options[0].Model, "prompt": options[0].Prompt} {
				if err := writer.WriteField(key, value); err != nil {
					pipeWriter.CloseWithError(err)
					return
				}
			}
			if options[0].Lyrics != nil {
				data, _ := json.Marshal(options[0].Lyrics)
				if err := writer.WriteField("reference_lyrics", string(data)); err != nil {
					pipeWriter.CloseWithError(err)
					return
				}
			}
		}
	}()

	updateProgress(0.15)

	// Send request — uses OpenAI-compatible endpoint
	url := c.baseURL + "/v1/audio/transcriptions"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, pipeReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", writer.FormDataContentType())

	log.Printf("[openvino-genai] sending request to %s (audio: %s)", url, audioPath)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("openvino-genai server request: %w", err)
	}
	defer resp.Body.Close()

	updateProgress(0.9)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		bodyStr := string(body)
		if isOOMError(bodyStr) {
			return nil, fmt.Errorf("GPU out of memory (status %d): %s", resp.StatusCode, bodyStr)
		}
		return nil, &serverResponseError{Status: resp.StatusCode, Body: bodyStr}
	}

	vtt := string(body)
	rawVTT := ""
	var diagnostics map[string]any
	if strings.HasPrefix(strings.TrimSpace(vtt), "{") {
		var result struct {
			VTT         string         `json:"vtt"`
			RawVTT      string         `json:"raw_vtt"`
			Diagnostics map[string]any `json:"diagnostics"`
		}
		if json.Unmarshal(body, &result) != nil {
			return nil, fmt.Errorf("추출 응답을 읽지 못했습니다")
		}
		vtt, rawVTT = result.VTT, result.RawVTT
		diagnostics = result.Diagnostics
	}

	if !strings.HasPrefix(strings.TrimSpace(vtt), "WEBVTT") || !strings.Contains(vtt, "-->") {
		return nil, fmt.Errorf("whisper returned no valid timed subtitles")
	}
	if rawVTT != "" && (!strings.HasPrefix(strings.TrimSpace(rawVTT), "WEBVTT") || !strings.Contains(rawVTT, "-->")) {
		return nil, fmt.Errorf("보정 전 자막의 시간 정보를 확인하지 못했습니다")
	}

	updateProgress(0.95)

	return &TranscribeResult{
		VTT:         vtt,
		RawVTT:      rawVTT,
		Diagnostics: diagnostics,
		Language:    language,
	}, nil
}
