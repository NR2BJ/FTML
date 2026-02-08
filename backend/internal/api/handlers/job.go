package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/job"
)

type JobHandler struct {
	queue *job.JobQueue
}

func NewJobHandler(queue *job.JobQueue) *JobHandler {
	return &JobHandler{queue: queue}
}

// ListJobs returns all jobs
func (h *JobHandler) ListJobs(w http.ResponseWriter, r *http.Request) {
	jobs, err := h.queue.ListJobs()
	if err != nil {
		jsonError(w, "failed to list jobs: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if jobs == nil {
		jobs = []*job.Job{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(jobs)
}

// GetJob returns a single job by ID
func (h *JobHandler) GetJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		jsonError(w, "missing job ID", http.StatusBadRequest)
		return
	}

	j, err := h.queue.GetJob(id)
	if err != nil {
		jsonError(w, "job not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(j)
}

// CancelJob cancels a pending or running job
func (h *JobHandler) CancelJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		jsonError(w, "missing job ID", http.StatusBadRequest)
		return
	}

	if err := h.queue.CancelJob(id); err != nil {
		jsonError(w, "failed to cancel job: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// RetryJob re-queues a failed or cancelled job
func (h *JobHandler) RetryJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		jsonError(w, "missing job ID", http.StatusBadRequest)
		return
	}

	if err := h.queue.RetryJob(id); err != nil {
		jsonError(w, "failed to retry job: "+err.Error(), http.StatusBadRequest)
		return
	}

	jsonResponse(w, map[string]string{"status": "retrying"}, http.StatusOK)
}
