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

func (c *WhisperCppClient) sendToServer(ctx context.Context, audioPath, language string, updateProgress func(float64)) (*TranscribeResult, error) {
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
		return nil, fmt.Errorf("whisper server error (status %d): %s", resp.StatusCode, string(body))
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
