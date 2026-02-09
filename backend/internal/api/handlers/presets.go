package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/db"
)

type PresetsHandler struct {
	database *db.Database
}

func NewPresetsHandler(database *db.Database) *PresetsHandler {
	return &PresetsHandler{database: database}
}

// ListPresets returns all saved translation presets
func (h *PresetsHandler) ListPresets(w http.ResponseWriter, r *http.Request) {
	presets, err := h.database.ListTranslationPresets()
	if err != nil {
		jsonError(w, "failed to list presets: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(presets)
}

// CreatePreset saves a new translation preset
func (h *PresetsHandler) CreatePreset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string `json:"name"`
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Name == "" || req.Prompt == "" {
		jsonError(w, "name and prompt are required", http.StatusBadRequest)
		return
	}

	id, err := h.database.CreateTranslationPreset(req.Name, req.Prompt)
	if err != nil {
		jsonError(w, "failed to create preset: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":   id,
		"name": req.Name,
	})
}

// UpdatePreset updates an existing translation preset
func (h *PresetsHandler) UpdatePreset(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid preset ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Name   string `json:"name"`
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Name == "" || req.Prompt == "" {
		jsonError(w, "name and prompt are required", http.StatusBadRequest)
		return
	}

	if err := h.database.UpdateTranslationPreset(id, req.Name, req.Prompt); err != nil {
		jsonError(w, "failed to update preset: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id":   id,
		"name": req.Name,
	})
}

// DeletePreset removes a saved translation preset
func (h *PresetsHandler) DeletePreset(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid preset ID", http.StatusBadRequest)
		return
	}

	if err := h.database.DeleteTranslationPreset(id); err != nil {
		jsonError(w, "failed to delete preset: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
