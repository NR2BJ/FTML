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

const openAITranscriptionURL = "https://api.openai.com/v1/audio/transcriptions"
const maxOpenAIFileSize = 25 * 1024 * 1024 // 25MB limit

// OpenAIWhisperClient uses the OpenAI Whisper API
type OpenAIWhisperClient struct {
	apiKey     string
	httpClient *http.Client
}

func NewOpenAIWhisperClient(apiKey string) *OpenAIWhisperClient {
	return &OpenAIWhisperClient{
		apiKey: apiKey,
		httpClient: &http.Client{
			Timeout: 10 * time.Minute,
		},
	}
}

func (c *OpenAIWhisperClient) Name() string {
	return "openai"
}

func (c *OpenAIWhisperClient) Transcribe(ctx context.Context, req TranscribeRequest, updateProgress func(float64)) (*TranscribeResult, error) {
	if c.apiKey == "" {
		return nil, fmt.Errorf("OpenAI API key not configured")
	}

	// Step 1: Extract audio as MP3 (smaller than WAV for upload)
	updateProgress(0.05)
	audioPath, err := extractAudioMP3(ctx, req.FilePath)
	if err != nil {
		return nil, fmt.Errorf("extract audio: %w", err)
	}
	defer os.Remove(audioPath)

	updateProgress(0.1)

	// Check file size
	info, err := os.Stat(audioPath)
	if err != nil {
		return nil, err
	}

	if info.Size() > maxOpenAIFileSize {
		// Split and process in chunks
		return c.transcribeChunked(ctx, req, audioPath, updateProgress)
	}

	// Single file transcription
	return c.transcribeSingle(ctx, audioPath, req.Language, updateProgress)
}

func (c *OpenAIWhisperClient) transcribeSingle(ctx context.Context, audioPath, language string, updateProgress func(float64)) (*TranscribeResult, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// Audio file
	audioFile, err := os.Open(audioPath)
	if err != nil {
		return nil, err
	}
	defer audioFile.Close()

	part, err := writer.CreateFormFile("file", filepath.Base(audioPath))
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, audioFile); err != nil {
		return nil, err
	}

	writer.WriteField("model", "whisper-1")
	writer.WriteField("response_format", "vtt")
	if language != "" && language != "auto" {
		writer.WriteField("language", language)
	}
	writer.Close()

	updateProgress(0.2)

	httpReq, err := http.NewRequestWithContext(ctx, "POST", openAITranscriptionURL, &buf)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", writer.FormDataContentType())
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	log.Printf("[whisper-openai] sending request to OpenAI API")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("OpenAI API request: %w", err)
	}
	defer resp.Body.Close()

	updateProgress(0.9)

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("OpenAI API error (status %d): %s", resp.StatusCode, string(body))
	}

	vtt := string(body)
	if !strings.HasPrefix(strings.TrimSpace(vtt), "WEBVTT") {
		vtt = "WEBVTT\n\n" + vtt
	}

	return &TranscribeResult{
		VTT:      vtt,
		Language: language,
	}, nil
}

// transcribeChunked splits a large audio file into chunks and transcribes each
func (c *OpenAIWhisperClient) transcribeChunked(ctx context.Context, req TranscribeRequest, audioPath string, updateProgress func(float64)) (*TranscribeResult, error) {
	// Split into 10-minute chunks with 1s overlap
	chunkDir, err := os.MkdirTemp("", "whisper-chunks-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(chunkDir)

	// Use FFmpeg to split
	chunkPattern := filepath.Join(chunkDir, "chunk_%03d.mp3")
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-i", audioPath,
		"-f", "segment",
		"-segment_time", "600", // 10 minutes
		"-c:a", "libmp3lame",
		"-q:a", "4",
		"-y",
		chunkPattern,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("ffmpeg split: %s: %w", string(output), err)
	}

	// Find chunks
	entries, err := os.ReadDir(chunkDir)
	if err != nil {
		return nil, err
	}

	var chunks []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".mp3") {
			chunks = append(chunks, filepath.Join(chunkDir, e.Name()))
		}
	}

	if len(chunks) == 0 {
		return nil, fmt.Errorf("no audio chunks generated")
	}

	updateProgress(0.15)

	// Transcribe each chunk
	var allVTT strings.Builder
	allVTT.WriteString("WEBVTT\n\n")

	for i, chunk := range chunks {
		progress := 0.15 + (0.75 * float64(i) / float64(len(chunks)))
		updateProgress(progress)

		result, err := c.transcribeSingle(ctx, chunk, req.Language, func(float64) {})
		if err != nil {
			return nil, fmt.Errorf("chunk %d: %w", i, err)
		}

		// Strip WEBVTT header from subsequent chunks and adjust timestamps
		vttContent := result.VTT
		vttContent = strings.TrimPrefix(strings.TrimSpace(vttContent), "WEBVTT")
		vttContent = strings.TrimSpace(vttContent)

		// TODO: Adjust timestamps based on chunk offset (i * 600 seconds)
		// For now, concatenate directly — timestamps from OpenAI are relative to chunk start
		if i > 0 && len(vttContent) > 0 {
			// Add offset to timestamps for chunks after the first
			offsetSeconds := float64(i) * 600.0
			vttContent = offsetVTTTimestamps(vttContent, offsetSeconds)
		}

		allVTT.WriteString(vttContent)
		allVTT.WriteString("\n\n")
	}

	updateProgress(0.95)

	return &TranscribeResult{
		VTT:      allVTT.String(),
		Language: req.Language,
	}, nil
}

// extractAudioMP3 extracts audio as MP3 for OpenAI (smaller file size)
func extractAudioMP3(ctx context.Context, videoPath string) (string, error) {
	tmpFile, err := os.CreateTemp("", "whisper-audio-*.mp3")
	if err != nil {
		return "", err
	}
	tmpFile.Close()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "error",
		"-i", videoPath,
		"-vn",
		"-acodec", "libmp3lame",
		"-q:a", "4", // ~130kbps VBR
		"-y",
		tmpFile.Name(),
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("ffmpeg: %s: %w", string(output), err)
	}

	return tmpFile.Name(), nil
}

// offsetVTTTimestamps adds seconds offset to all VTT timestamps in content
func offsetVTTTimestamps(content string, offsetSeconds float64) string {
	lines := strings.Split(content, "\n")
	var result strings.Builder

	for _, line := range lines {
		if strings.Contains(line, "-->") {
			parts := strings.Split(line, "-->")
			if len(parts) == 2 {
				start := offsetTimestamp(strings.TrimSpace(parts[0]), offsetSeconds)
				end := offsetTimestamp(strings.TrimSpace(parts[1]), offsetSeconds)
				result.WriteString(start + " --> " + end)
				result.WriteString("\n")
				continue
			}
		}
		result.WriteString(line)
		result.WriteString("\n")
	}

	return result.String()
}

// offsetTimestamp adds seconds to a VTT timestamp (HH:MM:SS.mmm)
func offsetTimestamp(ts string, offsetSeconds float64) string {
	// Parse HH:MM:SS.mmm
	var h, m, s int
	var ms int
	n, _ := fmt.Sscanf(ts, "%d:%d:%d.%d", &h, &m, &s, &ms)
	if n < 3 {
		return ts
	}

	totalMs := (h*3600+m*60+s)*1000 + ms + int(offsetSeconds*1000)
	if totalMs < 0 {
		totalMs = 0
	}

	newH := totalMs / 3600000
	totalMs %= 3600000
	newM := totalMs / 60000
	totalMs %= 60000
	newS := totalMs / 1000
	newMs := totalMs % 1000

	return fmt.Sprintf("%02d:%02d:%02d.%03d", newH, newM, newS, newMs)
}
