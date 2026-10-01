package whisper

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRetryableStatusesSurviveErrorWrapping(t *testing.T) {
	for _, status := range []int{409, 502, 503, 504} {
		if !isRetryableError(0, fmt.Errorf("wrapped: %w", &serverResponseError{Status: status})) {
			t.Fatalf("status %d not retryable", status)
		}
	}
	if isRetryableError(0, &serverResponseError{Status: 422}) {
		t.Fatal("invalid result must not retry")
	}
}

func TestWhisperRejectsUntimedSuccessResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("WEBVTT\n\n"))
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "audio.wav")
	if err := os.WriteFile(path, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := NewOpenVINOGenAIClient(server.URL).doSend(context.Background(), path, "ja", func(float64) {})
	if err == nil {
		t.Fatal("empty result reported as successful")
	}
}

func TestEnsureModelHonorsCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := NewOpenVINOGenAIClient("http://127.0.0.1:1").EnsureModel(ctx, "model"); err == nil {
		t.Fatal("cancelled request succeeded")
	}
}
