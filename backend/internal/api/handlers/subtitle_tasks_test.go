package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/job"
)

func TestSubtitleSubmissionPathsShareValidationAndMapping(t *testing.T) {
	media, subtitles := t.TempDir(), t.TempDir()
	d, err := db.NewSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	q := job.NewJobQueue(d.DB())
	defer q.Stop()
	h := NewSubtitleHandler(media, subtitles, q, d)
	r := chi.NewRouter()
	r.Post("/tasks", h.SubmitSubtitleTasks)
	r.Post("/generate/*", h.GenerateSubtitle)
	r.Post("/batch", h.BatchGenerate)
	r.Post("/translate-batch", h.BatchTranslate)
	for _, name := range []string{"a.mkv", "b.mkv", "c.mkv"} {
		if err = os.WriteFile(filepath.Join(media, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.WriteFile(filepath.Join(media, "b.zh.vtt"), []byte("WEBVTT\n\n00:00.000 --> 00:01.000\ntext\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// c.mkv의 후보로 c10의 자막이나 기존 번역 결과를 선택하면 안 된다.
	os.WriteFile(filepath.Join(media, "c10.zh.vtt"), []byte("WEBVTT\n"), 0600)
	os.MkdirAll(filepath.Join(subtitles, videoHash("c.mkv")), 0700)
	os.WriteFile(filepath.Join(subtitles, videoHash("c.mkv"), "translate_ko_gemini.vtt"), []byte("WEBVTT\n"), 0600)
	post := func(path, body string) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader(body)))
		return w
	}
	w := post("/tasks", `{"paths":["a.mkv"],"mode":"generate","generate":{"language":"ja","audio_track":1}}`)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct {
		Items []SubtitleTaskItem `json:"items"`
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	first := result.Items[0].JobID
	w = post("/generate/a.mkv", `{"language":"ja","audio_track":1}`)
	if w.Code != 201 || !strings.Contains(w.Body.String(), first) {
		t.Fatal("단일/공통 중복 작업", w.Body.String())
	}
	for _, endpoint := range []string{"/batch", "/tasks"} {
		body := `{"paths":["a.mkv"],"mode":"generate","audio_track":-1,"generate":{"audio_track":-1}}`
		if w = post(endpoint, body); w.Code != 400 {
			t.Fatal(endpoint, w.Code)
		}
	}
	w = post("/translate-batch", `{"paths":["a.mkv","b.mkv","b.mkv","c.mkv"],"target_lang":"ko","engine":"gemini"}`)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	if len(result.Items) != 3 || result.Items[0].Reason == "" || result.Items[1].Path != "b.mkv" || result.Items[1].JobID == "" || result.Items[2].Reason == "" {
		t.Fatal(w.Body.String())
	}
	if result.Items[1].SubtitleID != "external:b.zh.vtt" {
		t.Fatal(w.Body.String())
	}
	w = post("/tasks", `{"paths":["a.mkv"],"mode":"generate-translate","generate":{"language":"ja"},"translate":{"target_lang":"ko","engine":"deepl"}}`)
	if w.Code != 400 {
		t.Fatal("연속 작업 번역 설정 검증 누락", w.Body.String())
	}
	w = post("/tasks", `{"paths":["missing.mkv","../out.mkv"],"mode":"generate"}`)
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	if len(result.Items) != 2 || result.Items[0].Reason == "" || result.Items[1].Reason == "" {
		t.Fatal(w.Body.String())
	}
}

func TestTranslationSourcePriorityExcludesTranslatedResults(t *testing.T) {
	entries := []SubtitleEntry{
		{ID: "external:a.zh.ass", Type: "external"},
		{ID: "embedded:2", Type: "embedded"},
		{ID: "generated:translate_ko_gemini.ass", Type: "generated"},
		{ID: "generated:upload_zh.ass", Type: "generated"},
		{ID: "generated:whisper_ja.vtt", Type: "generated"},
	}
	for _, expected := range []string{"generated:whisper_ja.vtt", "generated:upload_zh.ass", "embedded:2", "external:a.zh.ass", ""} {
		if got := chooseTranslationSource(entries); got != expected {
			t.Fatalf("want %q, got %q", expected, got)
		}
		for i, entry := range entries {
			if entry.ID == expected {
				entries = append(entries[:i], entries[i+1:]...)
				break
			}
		}
	}
}
