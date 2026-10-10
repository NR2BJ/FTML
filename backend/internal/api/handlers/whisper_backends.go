package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
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
		log.Printf("[whisper-backends] failed to list: %v", err)
		jsonError(w, "failed to list backends", http.StatusInternalServerError)
		return
	}

	local := []db.WhisperBackend{}
	for _, b := range backends {
		if b.BackendType == "openvino-genai" {
			local = append(local, b)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(local)
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
		log.Printf("[whisper-backends] failed to list: %v", err)
		jsonError(w, "failed to list backends", http.StatusInternalServerError)
		return
	}

	var engines []AvailableEngine
	for _, b := range backends {
		if !b.Enabled || b.BackendType != "openvino-genai" {
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

	if err := validateLocalBackend(req.BackendType, req.URL); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}

	id, err := h.database.CreateWhisperBackend(req.Name, req.BackendType, req.URL, req.Priority)
	if err != nil {
		log.Printf("[whisper-backends] failed to create: %v", err)
		jsonError(w, "failed to create backend", http.StatusInternalServerError)
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
		Name        string  `json:"name"`
		BackendType string  `json:"backend_type"`
		URL         *string `json:"url"`
		Enabled     *bool   `json:"enabled"`
		Priority    *int    `json:"priority"`
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
	if req.URL != nil {
		existing.URL = *req.URL
	}
	if req.Enabled != nil {
		existing.Enabled = *req.Enabled
	}
	if req.Priority != nil {
		existing.Priority = *req.Priority
	}
	if err := validateLocalBackend(existing.BackendType, existing.URL); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := h.database.UpdateWhisperBackend(id, existing.Name, existing.BackendType, existing.URL, existing.Enabled, existing.Priority); err != nil {
		log.Printf("[whisper-backends] failed to update %d: %v", id, err)
		jsonError(w, "failed to update backend", http.StatusInternalServerError)
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
		log.Printf("[whisper-backends] failed to delete %d: %v", id, err)
		jsonError(w, "failed to delete backend", http.StatusInternalServerError)
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

	if err := validateLocalBackend(backend.BackendType, backend.URL); err != nil {
		json.NewEncoder(w).Encode(HealthResult{OK: false, Error: err.Error()})
		return
	}

	client := &http.Client{Timeout: 5 * time.Second}
	healthURL := strings.TrimRight(backend.URL, "/") + "/health"
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, healthURL, nil)
	if err != nil {
		json.NewEncoder(w).Encode(HealthResult{OK: false, Error: err.Error()})
		return
	}
	start := time.Now()
	resp, err := client.Do(req)
	latency := time.Since(start).Milliseconds()

	if err != nil {
		json.NewEncoder(w).Encode(HealthResult{OK: false, Error: err.Error()})
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		json.NewEncoder(w).Encode(HealthResult{OK: false, Error: fmt.Sprintf("음성 인식 서버 응답: %d", resp.StatusCode)})
		return
	}

	json.NewEncoder(w).Encode(HealthResult{OK: true, LatencyMs: latency})
}

func validateLocalBackend(kind, address string) error {
	if kind != "openvino-genai" {
		return fmt.Errorf("로컬 OpenVINO 음성 인식만 지원합니다")
	}
	u, err := url.Parse(address)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("음성 인식 서버의 HTTP(S) 주소를 입력해 주세요")
	}
	return nil
}
