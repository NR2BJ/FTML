package whisper

import (
	"bytes"
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
			Timeout: 30 * time.Minute, // transcription can be very long
		},
	}
}

func (c *OpenVINOGenAIClient) Name() string {
	return "openvino-genai"
}

// EnsureModel checks if the whisper server has the expected model loaded,
// and loads it if not. This handles server restarts where the server falls
// back to its default MODEL_ID env var instead of the DB-configured model.
func (c *OpenVINOGenAIClient) EnsureModel(expectedModelID string) error {
	if expectedModelID == "" {
		return nil
	}

	// Check current model via /v1/model/info
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(c.baseURL + "/v1/model/info")
	if err != nil {
		log.Printf("[openvino-genai] cannot check model info: %v", err)
		return nil // non-fatal, will fail later if server is truly down
	}
	defer resp.Body.Close()

	var info struct {
		Model  string `json:"model"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return nil
	}

	if info.Model == expectedModelID {
		return nil // already correct
	}

	log.Printf("[openvino-genai] model mismatch: server has %q, expected %q — loading correct model", info.Model, expectedModelID)
	loadURL := c.baseURL + "/v1/model/load"
	body := fmt.Sprintf(`{"model_id":"%s"}`, expectedModelID)
	loadClient := &http.Client{Timeout: 10 * time.Minute}
	loadResp, err := loadClient.Post(loadURL, "application/json", strings.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to load model %s: %w", expectedModelID, err)
	}
	defer loadResp.Body.Close()

	if loadResp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(loadResp.Body)
		return fmt.Errorf("failed to load model %s: status %d: %s", expectedModelID, loadResp.StatusCode, string(respBody))
	}

	log.Printf("[openvino-genai] model synced to %s", expectedModelID)
	return nil
}

// Transcribe sends an audio file to the OpenVINO GenAI server and returns VTT
func (c *OpenVINOGenAIClient) Transcribe(ctx context.Context, req TranscribeRequest, updateProgress func(float64)) (*TranscribeResult, error) {
	// Step 1: Extract audio from video using FFmpeg (WAV 16kHz mono)
	updateProgress(0.05)
	audioPath, err := extractAudio(ctx, req.FilePath)
	if err != nil {
		return nil, fmt.Errorf("extract audio: %w", err)
	}
	defer os.Remove(audioPath)

	updateProgress(0.1)

	// Step 2: Send to OpenVINO GenAI server with retries
	result, err := c.sendWithRetry(ctx, audioPath, req.Language, updateProgress)
	if err != nil {
		return nil, err
	}

	return result, nil
}

func (c *OpenVINOGenAIClient) sendWithRetry(ctx context.Context, audioPath, language string, updateProgress func(float64)) (*TranscribeResult, error) {
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

		result, err := c.doSend(ctx, audioPath, language, updateProgress)
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

func (c *OpenVINOGenAIClient) doSend(ctx context.Context, audioPath, language string, updateProgress func(float64)) (*TranscribeResult, error) {
	// Build multipart form
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// Add audio file
	audioFile, err := os.Open(audioPath)
	if err != nil {
		return nil, fmt.Errorf("open audio: %w", err)
	}
	defer audioFile.Close()

	part, err := writer.CreateFormFile("file", filepath.Base(audioPath))
	if err != nil {
		return nil, fmt.Errorf("create form file: %w", err)
	}
	if _, err := io.Copy(part, audioFile); err != nil {
		return nil, fmt.Errorf("copy audio data: %w", err)
	}

	// Add parameters
	writer.WriteField("response_format", "vtt")
	if language != "" && language != "auto" {
		writer.WriteField("language", language)
	}

	writer.Close()

	updateProgress(0.15)

	// Send request — uses OpenAI-compatible endpoint
	url := c.baseURL + "/v1/audio/transcriptions"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, &buf)
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
		if isRetryableError(resp.StatusCode, nil) {
			return nil, fmt.Errorf("openvino-genai server request: status %d: %s", resp.StatusCode, bodyStr)
		}
		return nil, fmt.Errorf("openvino-genai server error (status %d): %s", resp.StatusCode, bodyStr)
	}

	vtt := string(body)

	// Ensure VTT header
	if !strings.HasPrefix(strings.TrimSpace(vtt), "WEBVTT") {
		vtt = "WEBVTT\n\n" + vtt
	}

	updateProgress(0.95)

	return &TranscribeResult{
		VTT:      vtt,
		Language: language,
	}, nil
}
