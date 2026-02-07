package job

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
)

// JobQueue manages job persistence and dispatching
type JobQueue struct {
	db       *sql.DB
	mu       sync.RWMutex
	pending  chan string // job IDs to process
	cancels  map[string]context.CancelFunc
	handlers map[JobType]JobHandler
	ctx      context.Context
	cancel   context.CancelFunc
}

// NewJobQueue creates and starts a new job queue
func NewJobQueue(db *sql.DB) *JobQueue {
	ctx, cancel := context.WithCancel(context.Background())
	q := &JobQueue{
		db:       db,
		pending:  make(chan string, 100),
		cancels:  make(map[string]context.CancelFunc),
		handlers: make(map[JobType]JobHandler),
		ctx:      ctx,
		cancel:   cancel,
	}

	// Resume any pending/running jobs from DB on startup
	go q.resumeJobs()

	// Start worker
	go q.worker()

	return q
}

// RegisterHandler registers a handler for a job type
func (q *JobQueue) RegisterHandler(jobType JobType, handler JobHandler) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.handlers[jobType] = handler
}

// Enqueue creates a new job and adds it to the queue
func (q *JobQueue) Enqueue(jobType JobType, filePath string, params interface{}) (*Job, error) {
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

	// Push to worker channel
	select {
	case q.pending <- job.ID:
	default:
		log.Printf("[job] queue full, job %s will be picked up on next poll", job.ID)
	}

	return job, nil
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
	q.mu.Lock()
	if cancelFn, ok := q.cancels[id]; ok {
		cancelFn()
		delete(q.cancels, id)
	}
	q.mu.Unlock()

	_, err := q.db.Exec(`
		UPDATE jobs SET status = ?, completed_at = ?
		WHERE id = ? AND status IN (?, ?)`,
		StatusCancelled, time.Now(), id, StatusPending, StatusRunning,
	)
	return err
}

// UpdateProgress updates the progress of a running job
func (q *JobQueue) UpdateProgress(id string, progress float64) {
	q.db.Exec("UPDATE jobs SET progress = ? WHERE id = ?", progress, id)
}

// Stop shuts down the queue
func (q *JobQueue) Stop() {
	q.cancel()
}

// worker processes jobs from the pending channel one at a time
func (q *JobQueue) worker() {
	for {
		select {
		case <-q.ctx.Done():
			return
		case jobID := <-q.pending:
			q.processJob(jobID)
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

	if !ok {
		log.Printf("[job] no handler for job type %s", job.Type)
		q.failJob(job, fmt.Sprintf("no handler for job type: %s", job.Type))
		return
	}

	// Mark as running
	now := time.Now()
	job.StartedAt = &now
	job.Status = StatusRunning
	q.db.Exec("UPDATE jobs SET status = ?, started_at = ? WHERE id = ?",
		StatusRunning, now, job.ID)

	// Create cancellable context
	ctx, cancelFn := context.WithCancel(q.ctx)
	q.mu.Lock()
	q.cancels[job.ID] = cancelFn
	q.mu.Unlock()

	// Progress callback
	updateProgress := func(progress float64) {
		q.UpdateProgress(job.ID, progress)
	}

	// Run handler in a goroutine with context awareness
	done := make(chan error, 1)
	go func() {
		done <- handler(job, updateProgress)
	}()

	select {
	case <-ctx.Done():
		// Cancelled
		log.Printf("[job] job %s cancelled", job.ID)
	case err := <-done:
		if err != nil {
			q.failJob(job, err.Error())
		} else {
			q.completeJob(job)
		}
	}

	// Cleanup cancel func
	q.mu.Lock()
	delete(q.cancels, job.ID)
	q.mu.Unlock()
	cancelFn()
}

func (q *JobQueue) completeJob(job *Job) {
	now := time.Now()
	q.db.Exec("UPDATE jobs SET status = ?, progress = 1.0, completed_at = ? WHERE id = ?",
		StatusCompleted, now, job.ID)
	log.Printf("[job] job %s completed", job.ID)
}

func (q *JobQueue) failJob(job *Job, errMsg string) {
	now := time.Now()
	q.db.Exec("UPDATE jobs SET status = ?, error = ?, completed_at = ? WHERE id = ?",
		StatusFailed, errMsg, now, job.ID)
	log.Printf("[job] job %s failed: %s", job.ID, errMsg)
}

// resumeJobs re-queues any pending jobs found in DB on startup
func (q *JobQueue) resumeJobs() {
	// Mark any previously "running" jobs as pending (server restarted)
	q.db.Exec("UPDATE jobs SET status = ? WHERE status = ?", StatusPending, StatusRunning)

	rows, err := q.db.Query("SELECT id FROM jobs WHERE status = ? ORDER BY created_at ASC", StatusPending)
	if err != nil {
		log.Printf("[job] failed to resume jobs: %v", err)
		return
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			continue
		}
		select {
		case q.pending <- id:
			count++
		default:
		}
	}

	if count > 0 {
		log.Printf("[job] resumed %d pending jobs", count)
	}
}
