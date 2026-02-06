package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/db"
)

type UserHandler struct {
	db *db.Database
}

func NewUserHandler(db *db.Database) *UserHandler {
	return &UserHandler{db: db}
}

type savePositionRequest struct {
	Position float64 `json:"position"`
	Duration float64 `json:"duration"`
}

func (h *UserHandler) SavePosition(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	path := chi.URLParam(r, "*")
	var req savePositionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", http.StatusBadRequest)
		return
	}

	if err := h.db.SaveWatchPosition(claims.UserID, path, req.Position, req.Duration); err != nil {
		jsonError(w, "failed to save position", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{"status": "ok"}, http.StatusOK)
}

func (h *UserHandler) GetPosition(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	path := chi.URLParam(r, "*")
	pos, err := h.db.GetWatchPosition(claims.UserID, path)
	if err != nil {
		jsonError(w, "failed to get position", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]float64{"position": pos}, http.StatusOK)
}
