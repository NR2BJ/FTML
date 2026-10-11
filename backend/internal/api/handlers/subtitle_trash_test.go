package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/storage"
)

func TestSubtitleTrashHTTPPersistencePermissionsAndConflict(t *testing.T) {
	media, data := t.TempDir(), t.TempDir()
	dir := filepath.Join(data, videoHash("v.mkv"))
	os.Mkdir(dir, 0700)
	os.WriteFile(filepath.Join(dir, "whisper_ja.vtt"), []byte("WEBVTT\n\n原文"), 0600)
	newRouter := func() http.Handler {
		h := NewSubtitleHandler(media, data, nil, nil)
		r := chi.NewRouter()
		r.Use(middleware.RequireRole("admin"))
		r.Delete("/delete/*", h.DeleteSubtitle)
		r.Get("/trash/*", h.ListSubtitleTrash)
		r.Post("/restore/*", h.RestoreSubtitle)
		return r
	}
	router := newRouter()
	call := func(method, path, role string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r = r.WithContext(context.WithValue(r.Context(), middleware.UserClaimsKey, &auth.Claims{Role: role}))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	for _, role := range []string{"user", "viewer"} {
		for _, item := range []struct{ method, path string }{{"GET", "/trash/v.mkv"}, {"DELETE", "/delete/v.mkv?id=generated:whisper_ja.vtt"}, {"POST", "/restore/v.mkv?id=x"}} {
			if w := call(item.method, item.path, role); w.Code != 403 {
				t.Fatal(w.Code, w.Body.String())
			}
		}
	}
	if w := call("DELETE", "/delete/v.mkv?id=external:a.ass", "admin"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := call("DELETE", "/delete/v.mkv?id=generated:whisper_ja.vtt", "admin"); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	router = newRouter() // 새 처리기에서도 파일에 저장한 휴지통을 읽는다.
	w := call("GET", "/trash/v.mkv", "admin")
	var entries []storage.TrashedSubtitle
	if err := json.Unmarshal(w.Body.Bytes(), &entries); err != nil || len(entries) != 1 {
		t.Fatal(w.Body.String(), err)
	}
	id := url.QueryEscape(entries[0].ID)
	if w := call("POST", "/restore/other.mkv?id="+id, "admin"); w.Code != 404 {
		t.Fatal(w.Code)
	}
	os.WriteFile(filepath.Join(dir, "whisper_ja.vtt"), []byte("new"), 0600)
	if w := call("POST", "/restore/v.mkv?id="+id, "admin"); w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	os.Remove(filepath.Join(dir, "whisper_ja.vtt"))
	if w := call("POST", "/restore/v.mkv?id="+id, "admin"); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	content, _ := os.ReadFile(filepath.Join(dir, "whisper_ja.vtt"))
	if string(content) != "WEBVTT\n\n原文" {
		t.Fatal("원문 소실")
	}
}

func TestApprovedDeleteRequestUsesTrash(t *testing.T) {
	data := t.TempDir()
	database, err := db.NewSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	userID, err := database.CreateUser("admin", "hash", "admin")
	if err != nil {
		t.Fatal(err)
	}
	id, err := database.CreateDeleteRequest(userID, "admin", "v.mkv", "generated:a.ass", "번역 ← 원본", "")
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(data, videoHash("v.mkv"))
	os.Mkdir(dir, 0700)
	os.WriteFile(filepath.Join(dir, "a.ass"), []byte("ASS"), 0600)
	h := NewAdminHandler(database, nil, t.TempDir(), data)
	router := chi.NewRouter()
	router.Post("/{id}", h.ApproveDeleteRequest)
	r := httptest.NewRequest("POST", fmt.Sprintf("/%d", id), nil)
	r = r.WithContext(context.WithValue(r.Context(), middleware.UserClaimsKey, &auth.Claims{UserID: userID, Username: "admin", Role: "admin"}))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	entries, err := storage.ListSubtitleTrash(dir)
	if err != nil || len(entries) != 1 || entries[0].Label != "번역 ← 원본" {
		t.Fatal(entries, err)
	}
	if _, err := storage.RestoreSubtitle(dir, entries[0].ID); err != nil {
		t.Fatal(err)
	}
}
