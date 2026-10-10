package whisper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
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

func TestLocalASRStorageFullDoesNotRetryOrBecomeGPUError(t *testing.T) {
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusInsufficientStorage)
		json.NewEncoder(w).Encode(map[string]string{"detail": "음성 인식 서버의 저장 공간이 부족합니다"})
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "audio.wav")
	if err := os.WriteFile(path, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := NewOpenVINOGenAIClient(server.URL).sendWithRetry(context.Background(), path, "ja", func(float64) {})
	if err == nil || !strings.Contains(err.Error(), "저장 공간") || strings.Contains(err.Error(), "GPU out of memory") {
		t.Fatalf("저장 공간 오류가 잘못 전달됨: %v", err)
	}
	if attempts.Load() != 1 {
		t.Fatalf("공간 부족 작업을 %d번 요청함", attempts.Load())
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

func TestLocalASRHonorsCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	path := filepath.Join(t.TempDir(), "audio.wav")
	if err := os.WriteFile(path, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewOpenVINOGenAIClient("http://127.0.0.1:1").doSend(ctx, path, "ja", func(float64) {}); err == nil {
		t.Fatal("cancelled request succeeded")
	}
}

func TestLocalASRRequestCarriesAtomicModelAndReferences(t *testing.T) {
	vtt := "WEBVTT\n\n00:01.000 --> 00:02.000\noriginal\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(1024); err != nil {
			t.Error(err)
			return
		}
		defer r.MultipartForm.RemoveAll()
		for key, expected := range map[string]string{"response_format": "ftml_json", "model": "Qwen/Qwen3-ASR-1.7B", "language": "ja", "prompt": "名前", "observe_speech": "true"} {
			if r.FormValue(key) != expected {
				t.Errorf("%s: %q", key, r.FormValue(key))
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"vtt": vtt, "diagnostics": map[string]any{"timing_review_words": 2}})
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "audio.wav")
	if err := os.WriteFile(path, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	options := TranscribeRequest{Model: "Qwen/Qwen3-ASR-1.7B", Prompt: "名前", ObserveSpeech: true}
	client := NewOpenVINOGenAIClient(server.URL)
	result, err := client.doSend(context.Background(), path, "ja", func(float64) {}, options)
	if err != nil || result.VTT != vtt || result.Diagnostics["timing_review_words"] != float64(2) {
		t.Fatal(result, err)
	}

}
