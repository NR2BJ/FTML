package whisper

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// WhisperCppClient talks to the whisper.cpp HTTP server (whisper-server)
type WhisperCppClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewWhisperCppClient creates a client for the whisper.cpp server
func NewWhisperCppClient(baseURL string) *WhisperCppClient {
	return &WhisperCppClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: 30 * time.Minute, // transcription can be very long
		},
	}
}

func (c *WhisperCppClient) Name() string {
	return "whisper.cpp"
}

// Transcribe sends an audio file to whisper-server and returns VTT
func (c *WhisperCppClient) Transcribe(ctx context.Context, req TranscribeRequest, updateProgress func(float64)) (*TranscribeResult, error) {
	// Step 1: Extract audio from video using FFmpeg (WAV 16kHz mono)
	updateProgress(0.05)
	audioPath, err := extractAudio(ctx, req.FilePath)
	if err != nil {
		return nil, fmt.Errorf("extract audio: %w", err)
	}
	defer os.Remove(audioPath)

	updateProgress(0.1)

	// Step 2: Send to whisper-server
	result, err := c.sendToServer(ctx, audioPath, req.Language, updateProgress)
	if err != nil {
		return nil, err
	}

	return result, nil
}

// isOOMError checks if an error response indicates GPU out-of-memory
func isOOMError(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "out of memory") ||
		strings.Contains(lower, "allocation") ||
		strings.Contains(lower, "oom") ||
		strings.Contains(lower, "memory") && strings.Contains(lower, "failed") ||
		strings.Contains(lower, "sycl") && strings.Contains(lower, "error")
}

// isRetryableError checks if an HTTP error is transient and worth retrying
func isRetryableError(statusCode int, err error) bool {
	if err != nil {
		errStr := err.Error()
		return strings.Contains(errStr, "connection refused") ||
			strings.Contains(errStr, "connection reset") ||
			strings.Contains(errStr, "EOF") ||
			strings.Contains(errStr, "timeout")
	}
	return statusCode == 502 || statusCode == 503 || statusCode == 504
}

func (c *WhisperCppClient) sendToServer(ctx context.Context, audioPath, language string, updateProgress func(float64)) (*TranscribeResult, error) {
	const maxRetries = 3
	var lastErr error

	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			// Exponential backoff: 2s, 4s, 8s
			backoff := time.Duration(1<<uint(attempt)) * time.Second
			log.Printf("[whisper] retry %d/%d after %v", attempt, maxRetries, backoff)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		result, err := c.doSendToServer(ctx, audioPath, language, updateProgress)
		if err == nil {
			return result, nil
		}

		lastErr = err

		// Don't retry OOM errors — they will always fail
		if isOOMError(err.Error()) {
			return nil, fmt.Errorf("GPU out of memory — try a smaller model or quantized variant: %w", err)
		}

		// Don't retry context cancellation
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		// Only retry on transient errors
		if !isRetryableError(0, err) {
			return nil, err
		}

		log.Printf("[whisper] transient error (attempt %d/%d): %v", attempt+1, maxRetries+1, err)
	}

	return nil, fmt.Errorf("whisper server failed after %d attempts: %w", maxRetries+1, lastErr)
}

func (c *WhisperCppClient) doSendToServer(ctx context.Context, audioPath, language string, updateProgress func(float64)) (*TranscribeResult, error) {
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
	writer.WriteField("temperature", "0.0")
	if language != "" && language != "auto" {
		writer.WriteField("language", language)
	}

	writer.Close()

	updateProgress(0.15)

	// Send request
	url := c.baseURL + "/inference"
	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, &buf)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", writer.FormDataContentType())

	log.Printf("[whisper] sending request to %s (audio: %s)", url, audioPath)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("whisper server request: %w", err)
	}
	defer resp.Body.Close()

	updateProgress(0.9)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		bodyStr := string(body)
		// Check for OOM in response body
		if isOOMError(bodyStr) {
			return nil, fmt.Errorf("GPU out of memory (status %d): %s", resp.StatusCode, bodyStr)
		}
		// Check if retryable server error
		if isRetryableError(resp.StatusCode, nil) {
			return nil, fmt.Errorf("whisper server request: status %d: %s", resp.StatusCode, bodyStr)
		}
		return nil, fmt.Errorf("whisper server error (status %d): %s", resp.StatusCode, bodyStr)
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

// extractAudio uses FFmpeg to extract audio as WAV 16kHz mono (required by whisper)
func extractAudio(ctx context.Context, videoPath string) (string, error) {
	tmpFile, err := os.CreateTemp("", "whisper-audio-*.wav")
	if err != nil {
		return "", err
	}
	tmpFile.Close()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "error",
		"-i", videoPath,
		"-vn",           // no video
		"-acodec", "pcm_s16le",
		"-ar", "16000",  // 16kHz
		"-ac", "1",      // mono
		"-y",            // overwrite
		tmpFile.Name(),
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("ffmpeg: %s: %w", string(output), err)
	}

	return tmpFile.Name(), nil
}
