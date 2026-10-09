package job

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConcurrentDuplicateSubmissionsReuseOnlyActiveJob(t *testing.T) {
	q, d := newTestQueue(t)
	var wg sync.WaitGroup
	ids := make(chan string, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j, err := q.Enqueue(JobTranslate, "a.mkv", TranslateParams{Engine: "gemini", TargetLang: "ko"})
			if err != nil {
				t.Error(err)
				return
			}
			ids <- j.ID
		}()
	}
	wg.Wait()
	close(ids)
	first := ""
	for id := range ids {
		if first == "" {
			first = id
		}
		if id != first {
			t.Fatal("동일 활성 작업 중복 등록")
		}
	}
	// 이전 버전은 json.RawMessage를 BLOB으로 저장했으므로 문자열 비교만 하면 놓친다.
	if _, err := d.DB().Exec("UPDATE jobs SET params=CAST(params AS BLOB) WHERE id=?", first); err != nil {
		t.Fatal(err)
	}
	legacy, err := q.Enqueue(JobTranslate, "a.mkv", TranslateParams{Engine: "gemini", TargetLang: "ko"})
	if err != nil || legacy.ID != first {
		t.Fatal("기존 BLOB 작업 중복 등록", err)
	}
	if _, err := d.DB().Exec("UPDATE jobs SET status='completed', completed_at=? WHERE id=?", time.Now(), first); err != nil {
		t.Fatal(err)
	}
	next, err := q.Enqueue(JobTranslate, "a.mkv", TranslateParams{Engine: "gemini", TargetLang: "ko"})
	if err != nil || next.ID == first {
		t.Fatal("완료 이후 재작업이 차단됨", err)
	}
}

func TestChainCompletionIsAtomicAndRetryPreservesHistory(t *testing.T) {
	q, d := newTestQueue(t)
	q.RegisterHandler(JobTranscribe, func(_ context.Context, j *Job, _ func(float64)) error {
		j.Result = json.RawMessage(`{"output_path":"generated:whisper_ja.vtt"}`)
		return nil
	})
	if _, err := d.DB().Exec(`CREATE TRIGGER reject_child BEFORE INSERT ON jobs WHEN NEW.parent_id != '' BEGIN SELECT RAISE(ABORT, 'fixture'); END;`); err != nil {
		t.Fatal(err)
	}
	parent, err := q.Enqueue(JobTranscribe, "chain.mkv", TranscribeParams{Language: "ja", ChainTranslate: &TranslateParams{Engine: "gemini", TargetLang: "ko"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Start(); err != nil {
		t.Fatal(err)
	}
	awaitStatus(t, q, parent.ID, StatusFailed)
	tracked, err := q.TrackedJobs([]string{parent.ID})
	if err != nil || len(tracked) != 1 {
		t.Fatal(tracked, err)
	}
	if _, err = d.DB().Exec("DROP TRIGGER reject_child"); err != nil {
		t.Fatal(err)
	}
	next, err := q.RetryJob(parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	again, err := q.RetryJob(parent.ID)
	if err != nil || again.ID != next.ID {
		t.Fatal("재시도 중복", err)
	}
	awaitStatus(t, q, next.ID, StatusCompleted)
	tracked, err = q.TrackedJobs([]string{next.ID})
	if err != nil || len(tracked) != 2 {
		t.Fatal(tracked, err)
	}
	var child *Job
	for _, j := range tracked {
		if j.ParentID == next.ID {
			child = j
		}
	}
	if child == nil {
		t.Fatal("후속 번역 연결 누락")
	}
	awaitStatus(t, q, child.ID, StatusCompleted)
	var p TranslateParams
	if err = json.Unmarshal(child.Params, &p); err != nil || p.SubtitleID != "generated:whisper_ja.vtt" {
		t.Fatal(p, err)
	}
	old, _ := q.GetJob(parent.ID)
	if old.Status != StatusFailed || old.Error == "" || next.RetryOf != old.ID {
		t.Fatal("이전 실패 이력 손실")
	}
}

func TestVideoHistoryIncludesOldJobsAndPaginates(t *testing.T) {
	q, d := newTestQueue(t)
	for i := 0; i < 35; i++ {
		j, err := q.Enqueue(JobTranscribe, fmt.Sprintf("폴더/%02d.mkv", i), TranscribeParams{Language: "ja"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = d.DB().Exec("UPDATE jobs SET status='completed', completed_at=?, created_at=? WHERE id=?", time.Now().Add(-time.Hour), time.Now().Add(-time.Hour), j.ID); err != nil {
			t.Fatal(err)
		}
	}
	active, err := q.ListActiveJobs()
	if err != nil || len(active) != 0 {
		t.Fatal(active, err)
	}
	first, err := q.VideoHistory("폴더", "completed", 1)
	if err != nil || first.Total != 35 || len(first.Items) != 30 || first.Items[0].LastCreatedAt.IsZero() {
		t.Fatal(first, err)
	}
	second, err := q.VideoHistory("폴더", "completed", 2)
	if err != nil || len(second.Items) != 5 {
		t.Fatal(second, err)
	}
	for _, a := range first.Items {
		for _, b := range second.Items {
			if a.FilePath == b.FilePath {
				t.Fatal("페이지 중복")
			}
		}
	}
	jobs, total, err := q.HistoryForVideo(first.Items[0].FilePath, 1)
	if err != nil || total != 1 || len(jobs) != 1 {
		t.Fatal(jobs, total, err)
	}
	if _, err = q.VideoHistory("", "invalid", 1); err == nil {
		t.Fatal("잘못된 필터 허용")
	}
}

func TestRetryTranslationDoesNotRepeatTranscription(t *testing.T) {
	q, _ := newTestQueue(t)
	var transcriptions, translations atomic.Int32
	q.RegisterHandler(JobTranscribe, func(_ context.Context, j *Job, _ func(float64)) error {
		transcriptions.Add(1)
		j.Result = json.RawMessage(`{"output_path":"generated:whisper_ja_track1.vtt"}`)
		return nil
	})
	q.RegisterHandler(JobTranslate, func(_ context.Context, j *Job, _ func(float64)) error {
		if translations.Add(1) == 1 {
			return fmt.Errorf("fixture failure")
		}
		return nil
	})
	root, err := q.Enqueue(JobTranscribe, "a.mkv", TranscribeParams{AudioTrack: 1, ChainTranslate: &TranslateParams{Engine: "gemini", TargetLang: "ko"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Start(); err != nil {
		t.Fatal(err)
	}
	awaitStatus(t, q, root.ID, StatusCompleted)
	items, err := q.TrackedJobs([]string{root.ID})
	if err != nil || len(items) != 2 {
		t.Fatal(items, err)
	}
	child := items[1]
	awaitStatus(t, q, child.ID, StatusFailed)
	next, err := q.RetryJob(child.ID)
	if err != nil {
		t.Fatal(err)
	}
	awaitStatus(t, q, next.ID, StatusCompleted)
	if transcriptions.Load() != 1 || translations.Load() != 2 || next.ParentID != root.ID || next.RetryOf != child.ID {
		t.Fatal("잘못된 단계 재시도", next)
	}
	old, _ := q.GetJob(child.ID)
	if old.Status != StatusFailed || old.Error != "fixture failure" {
		t.Fatal("실패 기록 손실")
	}
}

func TestChainPersistenceAndCancelledCompletion(t *testing.T) {
	q, d := newTestQueue(t)
	params := TranscribeParams{ChainTranslate: &TranslateParams{Engine: "gemini", TargetLang: "ko"}}
	root, err := q.Enqueue(JobTranscribe, "persist.mkv", params)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.DB().Exec("UPDATE jobs SET status='running' WHERE id=?", root.ID); err != nil {
		t.Fatal(err)
	}
	root.Result = json.RawMessage(`{"output_path":"generated:whisper_ja.vtt"}`)
	q.completeJob(root)
	q.completeJob(root)
	items, err := q.TrackedJobs([]string{root.ID})
	if err != nil || len(items) != 2 {
		t.Fatal("중복 완료의 후속 번역은 한 번만 저장", items, err)
	}
	child := items[1]
	if child.Status != StatusPending {
		t.Fatal(child)
	}
	q.Stop()
	nextQueue := NewJobQueue(d.DB())
	defer nextQueue.Stop()
	nextQueue.RegisterHandler(JobTranscribe, func(context.Context, *Job, func(float64)) error { return fmt.Errorf("추출 재실행 금지") })
	nextQueue.RegisterHandler(JobTranslate, func(context.Context, *Job, func(float64)) error { return nil })
	if err = nextQueue.Start(); err != nil {
		t.Fatal(err)
	}
	awaitStatus(t, nextQueue, child.ID, StatusCompleted)
	nextQueue.Stop()
	q2 := NewJobQueue(d.DB())
	defer q2.Stop()
	cancelled, err := q2.Enqueue(JobTranscribe, "cancel.mkv", params)
	if err != nil {
		t.Fatal(err)
	}
	if err = q2.CancelJob(cancelled.ID); err != nil {
		t.Fatal(err)
	}
	cancelled.Result = root.Result
	q2.completeJob(cancelled)
	items, err = q2.TrackedJobs([]string{cancelled.ID})
	if err != nil || len(items) != 1 || items[0].Status != StatusCancelled {
		t.Fatal("취소한 추출에서 번역이 등록됨", items, err)
	}
}
