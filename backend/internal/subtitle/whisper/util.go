package whisper

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// extractAudio uses FFmpeg to extract audio as WAV 16kHz mono (required by whisper)
func extractAudio(ctx context.Context, videoPath string, audioTrack int) (string, error) {
	if audioTrack < 0 {
		return "", fmt.Errorf("잘못된 음성 트랙")
	}
	tmpFile, err := os.CreateTemp("", "whisper-audio-*.wav")
	if err != nil {
		return "", err
	}
	tmpFile.Close()

	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "error",
		"-i", videoPath,
		"-map", fmt.Sprintf("0:a:%d", audioTrack),
		"-vn", // no video
		// WAV는 PTS를 저장하지 않으므로 시작 지연과 중간 공백을 샘플로 보존한다.
		"-af", "aresample=16000:async=1:first_pts=0",
		"-ac", "1",
		"-acodec", "pcm_s16le",
		"-ar", "16000", // 16kHz
		"-y", // overwrite
		tmpFile.Name(),
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("ffmpeg: %s: %w", string(output), err)
	}

	return tmpFile.Name(), nil
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
	var responseError *serverResponseError
	if errors.As(err, &responseError) {
		statusCode = responseError.Status
		return statusCode == 502 || statusCode == 503 || statusCode == 504 || statusCode == 409
	}
	if err != nil {
		errStr := err.Error()
		return strings.Contains(errStr, "connection refused") ||
			strings.Contains(errStr, "connection reset") ||
			strings.Contains(errStr, "EOF") ||
			strings.Contains(errStr, "timeout")
	}
	return statusCode == 502 || statusCode == 503 || statusCode == 504
}

type serverResponseError struct {
	Status int
	Body   string
}

func (e *serverResponseError) Error() string {
	return fmt.Sprintf("whisper server status %d: %s", e.Status, e.Body)
}
