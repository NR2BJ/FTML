package handlers

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/api/middleware"
)

func TestMediaUploadAndConflict(t *testing.T) {
	dir := t.TempDir()
	h := NewFilesHandler(dir, t.TempDir())
	router := chi.NewRouter()
	router.Use(middleware.RequestBodyLimit)
	router.Post("/api/files/upload/*", h.Upload)
	for i, want := range []int{201, 409} {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", "movie.mp4")
		if err != nil {
			t.Fatal(err)
		}
		content := strings.Repeat(string(rune('a'+i)), 2<<20)
		if _, err = io.WriteString(part, content); err != nil {
			t.Fatal(err)
		}
		writer.Close()
		req := httptest.NewRequest("POST", "/api/files/upload/", &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != want {
			t.Fatalf("got %d, want %d: %s", w.Code, want, w.Body)
		}
	}
	content, err := os.ReadFile(filepath.Join(dir, "movie.mp4"))
	if err != nil || string(content) != strings.Repeat("a", 2<<20) {
		t.Fatal("original upload changed", err)
	}
}

func TestTrashNamesCannotEscape(t *testing.T) {
	for _, name := range []string{"", ".", "..", "../movie.mkv", "nested/item", `..\file`} {
		if validTrashName(name) {
			t.Fatalf("unsafe name accepted: %q", name)
		}
	}
	if !validTrashName("20261001_episode.mkv") {
		t.Fatal("valid trash name rejected")
	}
}

func TestSameBasenameTrashEntriesAreDistinct(t *testing.T) {
	dir := t.TempDir()
	h := NewFilesHandler(dir, t.TempDir())
	router := chi.NewRouter()
	router.Delete("/files/delete/*", h.Delete)
	for _, folder := range []string{"a", "b"} {
		os.Mkdir(filepath.Join(dir, folder), 0755)
		os.WriteFile(filepath.Join(dir, folder, "episode.mkv"), []byte(folder), 0600)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("DELETE", "/files/delete/"+folder+"/episode.mkv", nil))
		if w.Code != 204 {
			t.Fatalf("delete failed: %d %s", w.Code, w.Body)
		}
	}
	entries, err := os.ReadDir(h.trashDir())
	if err != nil || len(entries) != 4 {
		t.Fatalf("trash collision: %d entries, %v", len(entries), err)
	}
}
