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
	"strings"
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

func TestGlobalSubtitleTrashLegacyAndSettings(t *testing.T) {
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
	for _, path := range []string{"old.mkv", "new.mkv", "unknown.mkv"} {
		dir := filepath.Join(data, videoHash(path))
		os.Mkdir(dir, 0700)
		os.WriteFile(filepath.Join(dir, "a.vtt"), []byte(path), 0600)
		if path == "new.mkv" {
			_, err = storage.TrashSubtitle(dir, "a.vtt", "new", path)
		} else {
			_, err = storage.TrashSubtitle(dir, "a.vtt", "legacy")
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	database.CreateFileLog(userID, "admin", "subtitle_trash", "old.mkv", "a.vtt")
	h := NewSubtitleHandler(t.TempDir(), data, nil, database)
	w := httptest.NewRecorder()
	h.ListAllSubtitleTrash(w, httptest.NewRequest("GET", "/api/subtitle/trash", nil))
	var entries []storage.TrashedSubtitle
	if err := json.Unmarshal(w.Body.Bytes(), &entries); w.Code != 200 || err != nil || len(entries) != 3 {
		t.Fatal(w.Body.String(), err)
	}
	for _, entry := range entries {
		if entry.StorageKey == videoHash("old.mkv") && entry.VideoPath != "old.mkv" {
			t.Fatal(entry)
		}
		if entry.StorageKey == videoHash("new.mkv") && entry.VideoPath != "new.mkv" {
			t.Fatal(entry)
		}
		w = httptest.NewRecorder()
		h.RestoreGlobalSubtitle(w, httptest.NewRequest("POST", "/api/subtitle/trash/restore?storage_key="+entry.StorageKey+"&id="+entry.ID, nil))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w = httptest.NewRecorder()
	h.RestoreGlobalSubtitle(w, httptest.NewRequest("POST", "/api/subtitle/trash/restore?storage_key=../&id=x", nil))
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	settings := NewSettingsHandler(database)
	for _, value := range []string{"", "0", "7", "15", "30", "1", "-1", "garbage"} {
		w = httptest.NewRecorder()
		body := fmt.Sprintf(`{"subtitle_trash_retention_days":%q}`, value)
		settings.UpdateSettings(w, httptest.NewRequest("PUT", "/settings", strings.NewReader(body)))
		valid := value == "" || value == "0" || value == "7" || value == "15" || value == "30"
		if valid && (w.Code != 204 || database.GetSetting("subtitle_trash_retention_days", "") != value) {
			t.Fatal(value, w.Code)
		}
		if !valid && (w.Code != 400 || database.GetSetting("subtitle_trash_retention_days", "") != "30") {
			t.Fatal(value, w.Code)
		}
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
