package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/db"
)

type WhisperBackendsHandler struct {
	database *db.Database
}

func NewWhisperBackendsHandler(database *db.Database) *WhisperBackendsHandler {
	return &WhisperBackendsHandler{database: database}
}

// ListBackends returns all registered whisper backends (for Settings UI)
func (h *WhisperBackendsHandler) ListBackends(w http.ResponseWriter, r *http.Request) {
	backends, err := h.database.ListWhisperBackends()
	if err != nil {
		jsonError(w, "failed to list backends: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(backends)
}

// AvailableEngine is the dropdown-friendly format for frontends
type AvailableEngine struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Type  string `json:"type"`
}

// ListAvailable returns enabled backends as {value, label, type} for dropdowns
func (h *WhisperBackendsHandler) ListAvailable(w http.ResponseWriter, r *http.Request) {
	backends, err := h.database.ListWhisperBackends()
	if err != nil {
		jsonError(w, "failed to list backends: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var engines []AvailableEngine
	for _, b := range backends {
		if !b.Enabled {
			continue
		}
		engines = append(engines, AvailableEngine{
			Value: fmt.Sprintf("backend:%d", b.ID),
			Label: b.Name,
			Type:  b.BackendType,
		})
	}

	if engines == nil {
		engines = []AvailableEngine{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(engines)
}

// CreateBackend adds a new whisper backend
func (h *WhisperBackendsHandler) CreateBackend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		BackendType string `json:"backend_type"`
		URL         string `json:"url"`
		Priority    int    `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Name == "" || req.BackendType == "" {
		jsonError(w, "name and backend_type are required", http.StatusBadRequest)
		return
	}

	// Validate backend_type
	validTypes := map[string]bool{"sycl": true, "openvino": true, "cuda": true, "cpu": true, "openai": true}
	if !validTypes[req.BackendType] {
		jsonError(w, "backend_type must be one of: sycl, openvino, cuda, cpu, openai", http.StatusBadRequest)
		return
	}

	// Local backends require a URL
	if req.BackendType != "openai" && req.URL == "" {
		jsonError(w, "url is required for local backends", http.StatusBadRequest)
		return
	}

	id, err := h.database.CreateWhisperBackend(req.Name, req.BackendType, req.URL, req.Priority)
	if err != nil {
		jsonError(w, "failed to create backend: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":   id,
		"name": req.Name,
	})
}

// UpdateBackend modifies an existing whisper backend
func (h *WhisperBackendsHandler) UpdateBackend(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid backend ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name        string `json:"name"`
		BackendType string `json:"backend_type"`
		URL         string `json:"url"`
		Enabled     *bool  `json:"enabled"`
		Priority    int    `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Get current backend to merge with updates
	existing, err := h.database.GetWhisperBackend(id)
	if err != nil {
		jsonError(w, "backend not found", http.StatusNotFound)
		return
	}

	// Apply updates
	if req.Name != "" {
		existing.Name = req.Name
	}
	if req.BackendType != "" {
		existing.BackendType = req.BackendType
	}
	if req.URL != "" || req.BackendType == "openai" {
		existing.URL = req.URL
	}
	if req.Enabled != nil {
		existing.Enabled = *req.Enabled
	}
	if req.Priority != 0 {
		existing.Priority = req.Priority
	}

	if err := h.database.UpdateWhisperBackend(id, existing.Name, existing.BackendType, existing.URL, existing.Enabled, existing.Priority); err != nil {
		jsonError(w, "failed to update backend: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// DeleteBackend removes a whisper backend
func (h *WhisperBackendsHandler) DeleteBackend(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid backend ID", http.StatusBadRequest)
		return
	}

	if err := h.database.DeleteWhisperBackend(id); err != nil {
		jsonError(w, "failed to delete backend: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HealthCheck tests connectivity to a whisper backend
func (h *WhisperBackendsHandler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid backend ID", http.StatusBadRequest)
		return
	}

	backend, err := h.database.GetWhisperBackend(id)
	if err != nil {
		jsonError(w, "backend not found", http.StatusNotFound)
		return
	}

	type HealthResult struct {
		OK        bool   `json:"ok"`
		LatencyMs int64  `json:"latency_ms,omitempty"`
		Error     string `json:"error,omitempty"`
	}

	w.Header().Set("Content-Type", "application/json")

	if backend.BackendType == "openai" {
		// For OpenAI, just check if API key is configured
		key := h.database.GetSetting("openai_api_key", "")
		if key != "" {
			json.NewEncoder(w).Encode(HealthResult{OK: true})
		} else {
			json.NewEncoder(w).Encode(HealthResult{OK: false, Error: "OpenAI API key not configured"})
		}
		return
	}

	// For local backends, try to connect to the URL
	if backend.URL == "" {
		json.NewEncoder(w).Encode(HealthResult{OK: false, Error: "no URL configured"})
		return
	}

	client := &http.Client{Timeout: 5 * time.Second}
	start := time.Now()
	resp, err := client.Get(backend.URL)
	latency := time.Since(start).Milliseconds()

	if err != nil {
		json.NewEncoder(w).Encode(HealthResult{OK: false, Error: err.Error()})
		return
	}
	resp.Body.Close()

	json.NewEncoder(w).Encode(HealthResult{OK: true, LatencyMs: latency})
}
