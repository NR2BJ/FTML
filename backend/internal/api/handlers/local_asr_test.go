package handlers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/db"
)

func TestLocalASRAPIRejectsCloudAndBadHealth(t *testing.T) {
	d, err := db.NewSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	cloud, err := d.CreateWhisperBackend("Cloud", "openai", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer upstream.Close()
	local, err := d.CreateWhisperBackend("Local", "openvino-genai", upstream.URL, 0)
	if err != nil {
		t.Fatal(err)
	}
	h := NewWhisperBackendsHandler(d)
	r := chi.NewRouter()
	r.Get("/", h.ListBackends)
	r.Get("/available", h.ListAvailable)
	r.Post("/", h.CreateBackend)
	r.Put("/{id}", h.UpdateBackend)
	r.Post("/{id}/health", h.HealthCheck)
	for _, path := range []string{"/", "/available"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || strings.Contains(w.Body.String(), "Cloud") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/", `{"name":"Cloud","backend_type":"openai"}`},
		{"PUT", fmt.Sprintf("/%d", local), `{"backend_type":"openai"}`},
		{"PUT", fmt.Sprintf("/%d", local), `{"url":""}`},
		{"POST", "/", `{"name":"bad","backend_type":"openvino-genai","url":"file:///tmp/a"}`},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)))
		if w.Code != 400 {
			t.Fatal(tc, w.Code, w.Body.String())
		}
	}
	for _, id := range []int64{cloud, local} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("POST", fmt.Sprintf("/%d/health", id), nil))
		if !strings.Contains(w.Body.String(), `"ok":false`) {
			t.Fatal(w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	NewSettingsHandler(d).GetSettings(w, httptest.NewRequest("GET", "/", nil))
	if strings.Contains(w.Body.String(), "openai") {
		t.Fatal(w.Body.String())
	}
}
