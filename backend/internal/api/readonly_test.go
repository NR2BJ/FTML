package api

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/config"
	"github.com/video-stream/backend/internal/db"
)

func TestMediaWriteRoutesAreAbsentEvenForAdmin(t *testing.T) {
	media, data := t.TempDir(), t.TempDir()
	database, err := db.NewSQLite(filepath.Join(data, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	id, err := database.CreateUser("admin", "unused", "admin")
	if err != nil {
		t.Fatal(err)
	}
	user, err := database.GetUserByID(id)
	if err != nil {
		t.Fatal(err)
	}
	jwt := auth.NewJWTService("test-only-key")
	token, err := jwt.GenerateToken(id, user.Username, user.Role, user.AuthVersion)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(media, "episode.mkv")
	if err = os.WriteFile(file, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	router := NewRouter(database, jwt, &config.Config{MediaPath: media, DataPath: data, SubtitlePath: filepath.Join(data, "subtitles"), CORSOrigins: []string{"*"}}, nil, nil)
	for _, request := range [][2]string{
		{"POST", "/api/files/upload/"}, {"DELETE", "/api/files/delete/episode.mkv"},
		{"PUT", "/api/files/move"}, {"POST", "/api/files/mkdir/new"},
		{"GET", "/api/files/trash"}, {"POST", "/api/files/trash/restore"},
		{"DELETE", "/api/files/trash/empty"}, {"DELETE", "/api/files/trash/item"},
		{"POST", "/api/subtitle/reference-search/episode.mkv"},
	} {
		r := httptest.NewRequest(request[0], request[1], strings.NewReader(`{"source":"episode.mkv","destination":"moved.mkv"}`))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != 404 && w.Code != 405 {
			t.Errorf("%v: %d %s", request, w.Code, w.Body)
		}
	}
	r := httptest.NewRequest("GET", "/api/files/tree/", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "episode.mkv") {
		t.Fatal(w.Code, w.Body)
	}
	content, err := os.ReadFile(file)
	if err != nil || string(content) != "unchanged" {
		t.Fatal("미디어 변경", err)
	}
}

func TestSubtitleTrashRoutesRequireAdministrator(t *testing.T) {
	data := t.TempDir()
	database, err := db.NewSQLite(filepath.Join(data, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	jwt := auth.NewJWTService("test-only-key")
	router := NewRouter(database, jwt, &config.Config{MediaPath: t.TempDir(), DataPath: data, SubtitlePath: filepath.Join(data, "subtitles"), CORSOrigins: []string{"*"}}, nil, nil)
	for _, role := range []string{"admin", "user", "viewer"} {
		id, err := database.CreateUser(role, "unused", role)
		if err != nil {
			t.Fatal(err)
		}
		user, _ := database.GetUserByID(id)
		token, err := jwt.GenerateToken(id, user.Username, user.Role, user.AuthVersion)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range [][2]string{{"GET", "/api/subtitle/trash/episode.mkv"}, {"POST", "/api/subtitle/restore/episode.mkv?id=missing"}} {
			r := httptest.NewRequest(item[0], item[1], nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			expected := 403
			if role == "admin" {
				expected = 200
				if item[0] == "POST" {
					expected = 404
				}
			}
			if w.Code != expected {
				t.Fatalf("%s %v: %d %s", role, item, w.Code, w.Body)
			}
		}
	}
}
