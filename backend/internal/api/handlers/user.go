package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/auth"
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

	path := extractPath(r)
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

	path := extractPath(r)
	pos, err := h.db.GetWatchPosition(claims.UserID, path)
	if err != nil {
		jsonError(w, "failed to get position", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]float64{"position": pos}, http.StatusOK)
}

// ListHistory returns all watch history entries for the current user
func (h *UserHandler) ListHistory(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	entries, err := h.db.ListWatchHistory(claims.UserID)
	if err != nil {
		jsonError(w, "failed to list history", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, entries, http.StatusOK)
}

// DeleteHistory removes a specific watch history entry
func (h *UserHandler) DeleteHistory(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	path := extractPath(r)
	if err := h.db.DeleteWatchHistory(claims.UserID, path); err != nil {
		jsonError(w, "failed to delete history", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{"status": "ok"}, http.StatusOK)
}

// ChangePassword changes the current user's password
func (h *UserHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		jsonError(w, "current_password and new_password are required", http.StatusBadRequest)
		return
	}

	if len(req.NewPassword) < 8 {
		jsonError(w, "password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	// Verify current password
	user, err := h.db.GetUserByID(claims.UserID)
	if err != nil {
		jsonError(w, "user not found", http.StatusNotFound)
		return
	}

	if !auth.CheckPassword(req.CurrentPassword, user.Password) {
		jsonError(w, "current password is incorrect", http.StatusUnauthorized)
		return
	}

	// Hash and update new password
	hashed, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		jsonError(w, "failed to hash password", http.StatusInternalServerError)
		return
	}

	if err := h.db.UpdateUserPassword(claims.UserID, hashed); err != nil {
		jsonError(w, "failed to update password", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{"status": "ok"}, http.StatusOK)
}
