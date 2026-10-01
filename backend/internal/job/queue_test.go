package job

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/video-stream/backend/internal/db"
)

func newTestQueue(t *testing.T) (*JobQueue, *db.Database) {
	t.Helper()
	d, err := db.NewSQLite(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	q := NewJobQueue(d.DB())
	t.Cleanup(q.Stop)
	q.RegisterHandler(JobTranslate, func(context.Context, *Job, func(float64)) error { return nil })
	return q, d
}

func awaitStatus(t *testing.T, q *JobQueue, id string, status JobStatus) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		j, err := q.GetJob(id)
		if err == nil && j.Status == status {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	j, err := q.GetJob(id)
	t.Fatalf("wanted %s, got %+v (%v)", status, j, err)
}

func TestQueueDrainsMoreThanNotificationCapacity(t *testing.T) {
	q, _ := newTestQueue(t)
	q.RegisterHandler(JobTranscribe, func(context.Context, *Job, func(float64)) error { return nil })
	var ids []string
	for i := 0; i < 150; i++ {
		j, err := q.Enqueue(JobTranscribe, fmt.Sprintf("%d.mkv", i), TranscribeParams{})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, j.ID)
	}
	for _, id := range ids {
		j, _ := q.GetJob(id)
		if j.Status != StatusPending {
			t.Fatal("work started before handlers were ready")
		}
	}
	if err := q.Start(); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		awaitStatus(t, q, id, StatusCompleted)
	}
}

func TestCancellationWaitsForHandlerExit(t *testing.T) {
	q, _ := newTestQueue(t)
	started := make(chan string, 2)
	cancelObserved, release := make(chan struct{}), make(chan struct{})
	q.RegisterHandler(JobTranscribe, func(ctx context.Context, j *Job, progress func(float64)) error {
		started <- j.FilePath
		if j.FilePath == "first" {
			<-ctx.Done()
			close(cancelObserved)
			<-release
			progress(1)
		}
		return nil
	})
	first, _ := q.Enqueue(JobTranscribe, "first", TranscribeParams{})
	second, _ := q.Enqueue(JobTranscribe, "second", TranscribeParams{})
	if err := q.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start")
	}
	if err := q.CancelJob(first.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelObserved:
	case <-time.After(5 * time.Second):
		t.Fatal("cancel not propagated")
	}
	select {
	case <-started:
		close(release)
		t.Fatal("next job overlapped cancelled handler")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	awaitStatus(t, q, first.ID, StatusCancelled)
	awaitStatus(t, q, second.ID, StatusCompleted)
	j, _ := q.GetJob(first.ID)
	if j.Progress != 0 {
		t.Fatal("cancelled job progress was overwritten")
	}
}

func TestShutdownLeavesRunningJobResumable(t *testing.T) {
	q, d := newTestQueue(t)
	started := make(chan struct{})
	q.RegisterHandler(JobTranscribe, func(ctx context.Context, j *Job, progress func(float64)) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	})
	j, _ := q.Enqueue(JobTranscribe, "resume.mkv", TranscribeParams{})
	if err := q.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start")
	}
	q.Stop()
	awaitStatus(t, q, j.ID, StatusPending)
	next := NewJobQueue(d.DB())
	defer next.Stop()
	noop := func(context.Context, *Job, func(float64)) error { return nil }
	next.RegisterHandler(JobTranscribe, noop)
	next.RegisterHandler(JobTranslate, noop)
	if err := next.Start(); err != nil {
		t.Fatal(err)
	}
	awaitStatus(t, next, j.ID, StatusCompleted)
}
