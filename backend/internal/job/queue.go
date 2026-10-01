package job

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

// JobQueue manages job persistence and dispatching
type JobQueue struct {
	db                *sql.DB
	mu                sync.RWMutex
	pendingTranscribe chan string // transcribe jobs (GPU-bound, processed one at a time)
	pendingTranslate  chan string // translate jobs (web API, runs concurrently with transcribe)
	cancels           map[string]context.CancelFunc
	handlers          map[JobType]JobHandler
	ctx               context.Context
	cancel            context.CancelFunc
	startOnce         sync.Once
	startErr          error
	workers           sync.WaitGroup
}

// NewJobQueue creates a queue. Register handlers before calling Start.
func NewJobQueue(db *sql.DB) *JobQueue {
	ctx, cancel := context.WithCancel(context.Background())
	q := &JobQueue{
		db:                db,
		pendingTranscribe: make(chan string, 1),
		pendingTranslate:  make(chan string, 1),
		cancels:           make(map[string]context.CancelFunc),
		handlers:          make(map[JobType]JobHandler),
		ctx:               ctx,
		cancel:            cancel,
	}

	return q
}

func (q *JobQueue) Start() error {
	q.startOnce.Do(func() {
		q.mu.RLock()
		_, transcribeOK := q.handlers[JobTranscribe]
		_, translateOK := q.handlers[JobTranslate]
		q.mu.RUnlock()
		if !transcribeOK || !translateOK {
			q.startErr = fmt.Errorf("register transcription and translation handlers before starting")
			return
		}
		_, q.startErr = q.db.Exec("UPDATE jobs SET status = ?, started_at = NULL, progress = 0 WHERE status = ?", StatusPending, StatusRunning)
		if q.startErr != nil {
			return
		}
		q.workers.Add(2)
		go q.worker(JobTranscribe, q.pendingTranscribe)
		go q.worker(JobTranslate, q.pendingTranslate)
	})
	return q.startErr
}

// RegisterHandler registers a handler for a job type
func (q *JobQueue) RegisterHandler(jobType JobType, handler JobHandler) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.handlers[jobType] = handler
}

// Enqueue creates a new job and adds it to the queue
func (q *JobQueue) Enqueue(jobType JobType, filePath string, params interface{}) (*Job, error) {
	if jobType != JobTranscribe && jobType != JobTranslate {
		return nil, fmt.Errorf("unsupported job type: %s", jobType)
	}
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("marshal params: %w", err)
	}

	job := &Job{
		ID:        uuid.New().String(),
		Type:      jobType,
		Status:    StatusPending,
		FilePath:  filePath,
		Params:    paramsJSON,
		Progress:  0,
		CreatedAt: time.Now(),
	}

	_, err = q.db.Exec(`
		INSERT INTO jobs (id, type, status, file_path, params, progress, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		job.ID, job.Type, job.Status, job.FilePath, job.Params, job.Progress, job.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert job: %w", err)
	}

	// Push to appropriate worker channel
	q.enqueueToChannel(jobType, job.ID)

	return job, nil
}

// enqueueToChannel pushes a job ID to the appropriate channel based on type
func (q *JobQueue) enqueueToChannel(jobType JobType, jobID string) {
	switch jobType {
	case JobTranscribe:
		select {
		case q.pendingTranscribe <- jobID:
		default:
			// A wake-up is already pending; the worker drains jobs from SQLite.
		}
	case JobTranslate:
		select {
		case q.pendingTranslate <- jobID:
		default:
			// SQLite remains authoritative even when notifications coalesce.
		}
	default:
		log.Printf("[job] unknown job type %s for job %s", jobType, jobID)
	}
}

// GetJob retrieves a job by ID
func (q *JobQueue) GetJob(id string) (*Job, error) {
	job := &Job{}
	var params, result sql.NullString
	var startedAt, completedAt sql.NullTime
	var errMsg sql.NullString

	err := q.db.QueryRow(`
		SELECT id, type, status, file_path, params, progress, result, error, created_at, started_at, completed_at
		FROM jobs WHERE id = ?`, id,
	).Scan(&job.ID, &job.Type, &job.Status, &job.FilePath, &params, &job.Progress,
		&result, &errMsg, &job.CreatedAt, &startedAt, &completedAt)
	if err != nil {
		return nil, err
	}

	if params.Valid {
		job.Params = json.RawMessage(params.String)
	}
	if result.Valid {
		job.Result = json.RawMessage(result.String)
	}
	if errMsg.Valid {
		job.Error = errMsg.String
	}
	if startedAt.Valid {
		job.StartedAt = &startedAt.Time
	}
	if completedAt.Valid {
		job.CompletedAt = &completedAt.Time
	}

	return job, nil
}

// ListJobs returns all jobs ordered by creation time (newest first)
func (q *JobQueue) ListJobs() ([]*Job, error) {
	rows, err := q.db.Query(`
		SELECT id, type, status, file_path, params, progress, result, error, created_at, started_at, completed_at
		FROM jobs ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return q.scanJobs(rows)
}

// ListActiveJobs returns pending/running jobs + recently completed/failed (within 60s)
func (q *JobQueue) ListActiveJobs() ([]*Job, error) {
	cutoff := time.Now().Add(-60 * time.Second)
	rows, err := q.db.Query(`
		SELECT id, type, status, file_path, params, progress, result, error, created_at, started_at, completed_at
		FROM jobs
		WHERE status IN (?, ?)
		   OR (status IN (?, ?) AND completed_at > ?)
		ORDER BY created_at DESC`,
		StatusPending, StatusRunning, StatusCompleted, StatusFailed, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	return q.scanJobs(rows)
}

// scanJobs reads job rows into a slice
func (q *JobQueue) scanJobs(rows *sql.Rows) ([]*Job, error) {
	var jobs []*Job
	for rows.Next() {
		job := &Job{}
		var params, result sql.NullString
		var startedAt, completedAt sql.NullTime
		var errMsg sql.NullString

		if err := rows.Scan(&job.ID, &job.Type, &job.Status, &job.FilePath, &params, &job.Progress,
			&result, &errMsg, &job.CreatedAt, &startedAt, &completedAt); err != nil {
			return nil, err
		}

		if params.Valid {
			job.Params = json.RawMessage(params.String)
		}
		if result.Valid {
			job.Result = json.RawMessage(result.String)
		}
		if errMsg.Valid {
			job.Error = errMsg.String
		}
		if startedAt.Valid {
			job.StartedAt = &startedAt.Time
		}
		if completedAt.Valid {
			job.CompletedAt = &completedAt.Time
		}

		jobs = append(jobs, job)
	}

	return jobs, nil
}

// CancelJob cancels a pending or running job
func (q *JobQueue) CancelJob(id string) error {
	_, err := q.db.Exec(`UPDATE jobs SET status = ?, completed_at = ? WHERE id = ? AND status IN (?, ?)`,
		StatusCancelled, time.Now(), id, StatusPending, StatusRunning)
	if err != nil {
		return err
	}
	q.mu.Lock()
	if cancelFn, ok := q.cancels[id]; ok {
		cancelFn()
		delete(q.cancels, id)
	}
	q.mu.Unlock()

	return nil
}

// RetryJob re-queues a failed or cancelled job
func (q *JobQueue) RetryJob(id string) error {
	job, err := q.GetJob(id)
	if err != nil {
		return fmt.Errorf("job not found")
	}

	if job.Status != StatusFailed && job.Status != StatusCancelled {
		return fmt.Errorf("only failed or cancelled jobs can be retried")
	}

	// Reset job state to pending
	_, err = q.db.Exec(`
		UPDATE jobs SET status = ?, progress = 0, error = NULL, result = NULL, started_at = NULL, completed_at = NULL
		WHERE id = ?`,
		StatusPending, id,
	)
	if err != nil {
		return fmt.Errorf("failed to reset job: %w", err)
	}

	// Push to appropriate worker channel
	q.enqueueToChannel(job.Type, id)

	log.Printf("[job] retrying job %s", id)
	return nil
}

// UpdateProgress updates the progress of a running job
func (q *JobQueue) UpdateProgress(id string, progress float64) {
	q.db.Exec("UPDATE jobs SET progress = ? WHERE id = ? AND status = ?", progress, id, StatusRunning)
}

// Stop shuts down the queue
func (q *JobQueue) Stop() {
	q.cancel()
	q.workers.Wait()
}

// transcribeWorker processes transcribe jobs one at a time (GPU-bound)
func (q *JobQueue) worker(kind JobType, wake <-chan string) {
	defer q.workers.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for q.ctx.Err() == nil {
		var id string
		err := q.db.QueryRow("SELECT id FROM jobs WHERE type = ? AND status = ? ORDER BY created_at, id LIMIT 1", kind, StatusPending).Scan(&id)
		if err == nil {
			q.processJob(id)
			continue
		}
		if err != sql.ErrNoRows {
			log.Printf("[job] pending job lookup failed: %v", err)
		}
		select {
		case <-q.ctx.Done():
			return
		case <-wake:
		case <-ticker.C:
		}
	}
}

// processJob runs a single job
func (q *JobQueue) processJob(jobID string) {
	job, err := q.GetJob(jobID)
	if err != nil {
		log.Printf("[job] failed to load job %s: %v", jobID, err)
		return
	}

	// Skip if not pending
	if job.Status != StatusPending {
		return
	}

	// Get handler
	q.mu.RLock()
	handler, ok := q.handlers[job.Type]
	q.mu.RUnlock()

	// Mark as running
	now := time.Now()
	claim, err := q.db.Exec("UPDATE jobs SET status = ?, started_at = ? WHERE id = ? AND status = ?",
		StatusRunning, now, job.ID, StatusPending)
	if err != nil {
		log.Printf("[job] claim failed: %v", err)
		return
	}
	claimed, err := claim.RowsAffected()
	if err != nil || claimed != 1 {
		return
	}
	job.StartedAt = &now
	job.Status = StatusRunning
	if !ok {
		q.failJob(job, fmt.Sprintf("no handler for job type: %s", job.Type))
		return
	}

	// Create cancellable context
	ctx, cancelFn := context.WithCancel(q.ctx)
	q.mu.Lock()
	q.cancels[job.ID] = cancelFn
	q.mu.Unlock()
	var currentStatus JobStatus
	if err := q.db.QueryRow("SELECT status FROM jobs WHERE id = ?", job.ID).Scan(&currentStatus); err != nil || currentStatus != StatusRunning {
		cancelFn()
	}

	// Progress callback
	updateProgress := func(progress float64) {
		q.UpdateProgress(job.ID, progress)
	}

	// Run handler in a goroutine with context awareness
	done := make(chan error, 1)
	go func() {
		if ctx.Err() != nil {
			done <- ctx.Err()
			return
		}
		done <- handler(ctx, job, updateProgress)
	}()

	select {
	case <-ctx.Done():
		// Do not reuse the worker until its handler has actually stopped.
		<-done
		log.Printf("[job] job %s cancelled", job.ID)
	case err := <-done:
		if q.ctx.Err() != nil {
			break
		}
		if err != nil {
			q.failJob(job, err.Error())
		} else {
			q.completeJob(job)
		}
	}
	if q.ctx.Err() != nil {
		q.db.Exec("UPDATE jobs SET status = ?, started_at = NULL, progress = 0 WHERE id = ? AND status = ?", StatusPending, job.ID, StatusRunning)
	}

	// Cleanup cancel func
	q.mu.Lock()
	delete(q.cancels, job.ID)
	q.mu.Unlock()
	cancelFn()
}

func (q *JobQueue) completeJob(job *Job) {
	now := time.Now()
	// Persist result to DB (handlers set job.Result before returning)
	result, err := q.db.Exec("UPDATE jobs SET status = ?, progress = 1.0, result = ?, completed_at = ? WHERE id = ? AND status = ?",
		StatusCompleted, string(job.Result), now, job.ID, StatusRunning)
	if err != nil {
		log.Printf("[job] completion persistence failed: %v", err)
		return
	}
	changed, err := result.RowsAffected()
	if err != nil || changed != 1 {
		return
	}
	log.Printf("[job] job %s completed", job.ID)

	// Chain: if transcribe job has ChainTranslate, auto-enqueue translation
	if job.Type == JobTranscribe {
		q.maybeChainTranslate(job)
	}
}

// maybeChainTranslate checks if a completed transcribe job should trigger a translation job
func (q *JobQueue) maybeChainTranslate(job *Job) {
	var params TranscribeParams
	if err := json.Unmarshal(job.Params, &params); err != nil {
		return
	}
	if params.ChainTranslate == nil {
		return
	}

	var result TranscribeResult
	if err := json.Unmarshal(job.Result, &result); err != nil {
		log.Printf("[job] chain: failed to parse transcribe result for job %s: %v", job.ID, err)
		return
	}

	// Extract subtitle ID from output path (e.g., "generated:whisper_ja.vtt")
	subtitleID := result.OutputPath
	if subtitleID == "" {
		log.Printf("[job] chain: no output path in transcribe result for job %s", job.ID)
		return
	}

	// Build translate params from chain config
	translateParams := *params.ChainTranslate
	translateParams.SubtitleID = subtitleID

	chainJob, err := q.Enqueue(JobTranslate, job.FilePath, translateParams)
	if err != nil {
		log.Printf("[job] chain: failed to enqueue translation for job %s: %v", job.ID, err)
		return
	}

	fileName := filepath.Base(job.FilePath)
	log.Printf("[job] chain: transcribe %s → translate %s (file: %s)", job.ID, chainJob.ID, fileName)
}

func (q *JobQueue) failJob(job *Job, errMsg string) {
	now := time.Now()
	q.db.Exec("UPDATE jobs SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status = ?",
		StatusFailed, errMsg, now, job.ID, StatusRunning)
	log.Printf("[job] job %s failed: %s", job.ID, errMsg)
}
