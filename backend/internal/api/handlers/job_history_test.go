package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/job"
)

func TestJobHistoryHTTPPreservesPathsAndOldRecords(t *testing.T) {
	d, err := db.NewSQLite(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	q := job.NewJobQueue(d.DB())
	defer q.Stop()
	path := "애니/01 + # & %.mkv"
	j, err := q.Enqueue(job.JobTranscribe, path, job.TranscribeParams{Language: "ja"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB().Exec("UPDATE jobs SET status='completed', completed_at=? WHERE id=?", time.Now().Add(-24*time.Hour), j.ID); err != nil {
		t.Fatal(err)
	}
	h := NewJobHandler(q)
	r := chi.NewRouter()
	r.Get("/videos", h.VideoHistory)
	r.Get("/history", h.HistoryForVideo)
	r.Get("/tracked", h.TrackedJobs)
	get := func(path string, status int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != status {
			t.Fatal(path, w.Code, w.Body.String())
		}
		return w
	}
	var videos job.VideoHistoryPage
	w := get("/videos?q="+url.QueryEscape("# & %")+"&status=completed", 200)
	if err = json.Unmarshal(w.Body.Bytes(), &videos); err != nil || videos.Total != 1 || videos.Items[0].FilePath != path {
		t.Fatal(w.Body.String(), err)
	}
	var history struct {
		Items []*job.Job `json:"items"`
		Total int        `json:"total"`
	}
	w = get("/history?path="+url.QueryEscape(path), 200)
	if err = json.Unmarshal(w.Body.Bytes(), &history); err != nil || history.Total != 1 || history.Items[0].ID != j.ID {
		t.Fatal(w.Body.String(), err)
	}
	get("/tracked?ids="+j.ID, 200)
	get("/videos?status=unknown", 400)
	get("/videos?page=0", 400)
	get("/history?page=1", 400)
	get("/tracked", 400)
}
