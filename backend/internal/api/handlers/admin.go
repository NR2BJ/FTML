package handlers

import (
	"encoding/json"
	"net/http"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/gpu"
)

var startTime = time.Now()

type AdminHandler struct {
	db         *db.Database
	hlsManager *ffmpeg.HLSManager
	mediaPath  string
}

func NewAdminHandler(db *db.Database, hlsManager *ffmpeg.HLSManager, mediaPath ...string) *AdminHandler {
	mp := ""
	if len(mediaPath) > 0 {
		mp = mediaPath[0]
	}
	return &AdminHandler{db: db, hlsManager: hlsManager, mediaPath: mp}
}

// ListUsers returns all users
func (h *AdminHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.db.ListUsers()
	if err != nil {
		jsonError(w, "failed to list users: "+err.Error(), http.StatusInternalServerError)
		return
	}
	jsonResponse(w, users, http.StatusOK)
}

// CreateUser creates a new user
func (h *AdminHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Username == "" || req.Password == "" {
		jsonError(w, "username and password are required", http.StatusBadRequest)
		return
	}

	validRoles := map[string]bool{"admin": true, "editor": true, "viewer": true}
	if !validRoles[req.Role] {
		jsonError(w, "role must be one of: admin, editor, viewer", http.StatusBadRequest)
		return
	}

	hashed, err := auth.HashPassword(req.Password)
	if err != nil {
		jsonError(w, "failed to hash password", http.StatusInternalServerError)
		return
	}

	id, err := h.db.CreateUser(req.Username, hashed, req.Role)
	if err != nil {
		jsonError(w, "failed to create user (username may already exist)", http.StatusConflict)
		return
	}

	jsonResponse(w, map[string]interface{}{"id": id, "username": req.Username, "role": req.Role}, http.StatusCreated)
}

// UpdateUser updates user details
func (h *AdminHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid user ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Username string `json:"username"`
		Role     string `json:"role"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Get current user
	existing, err := h.db.GetUserByID(id)
	if err != nil {
		jsonError(w, "user not found", http.StatusNotFound)
		return
	}

	// Prevent demoting the last admin
	if existing.Role == "admin" && req.Role != "" && req.Role != "admin" {
		count, err := h.db.CountAdmins()
		if err != nil {
			jsonError(w, "failed to check admin count", http.StatusInternalServerError)
			return
		}
		if count <= 1 {
			jsonError(w, "cannot demote the last admin", http.StatusBadRequest)
			return
		}
	}

	// Apply updates
	username := existing.Username
	role := existing.Role
	if req.Username != "" {
		username = req.Username
	}
	if req.Role != "" {
		validRoles := map[string]bool{"admin": true, "editor": true, "viewer": true}
		if !validRoles[req.Role] {
			jsonError(w, "role must be one of: admin, editor, viewer", http.StatusBadRequest)
			return
		}
		role = req.Role
	}

	if err := h.db.UpdateUser(id, username, role); err != nil {
		jsonError(w, "failed to update user: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Update password if provided
	if req.Password != "" {
		hashed, err := auth.HashPassword(req.Password)
		if err != nil {
			jsonError(w, "failed to hash password", http.StatusInternalServerError)
			return
		}
		if err := h.db.UpdateUserPassword(id, hashed); err != nil {
			jsonError(w, "failed to update password", http.StatusInternalServerError)
			return
		}
	}

	jsonResponse(w, map[string]string{"status": "ok"}, http.StatusOK)
}

// DeleteUser removes a user
func (h *AdminHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid user ID", http.StatusBadRequest)
		return
	}

	// Prevent self-deletion
	claims := middleware.GetClaims(r)
	if claims != nil && claims.UserID == id {
		jsonError(w, "cannot delete yourself", http.StatusBadRequest)
		return
	}

	// Prevent deleting the last admin
	user, err := h.db.GetUserByID(id)
	if err != nil {
		jsonError(w, "user not found", http.StatusNotFound)
		return
	}
	if user.Role == "admin" {
		count, err := h.db.CountAdmins()
		if err != nil {
			jsonError(w, "failed to check admin count", http.StatusInternalServerError)
			return
		}
		if count <= 1 {
			jsonError(w, "cannot delete the last admin", http.StatusBadRequest)
			return
		}
	}

	if err := h.db.DeleteUser(id); err != nil {
		jsonError(w, "failed to delete user: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{"status": "ok"}, http.StatusOK)
}

// GetUserHistory returns watch history for a specific user (admin view)
func (h *AdminHandler) GetUserHistory(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid user ID", http.StatusBadRequest)
		return
	}

	history, err := h.db.ListWatchHistory(id)
	if err != nil {
		jsonError(w, "failed to get history", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, history, http.StatusOK)
}

// ListRegistrations returns registration requests
func (h *AdminHandler) ListRegistrations(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}

	regs, err := h.db.ListRegistrations(status)
	if err != nil {
		jsonError(w, "failed to list registrations", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, regs, http.StatusOK)
}

// ApproveRegistration approves a pending registration
func (h *AdminHandler) ApproveRegistration(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid registration ID", http.StatusBadRequest)
		return
	}

	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	if err := h.db.ApproveRegistration(id, claims.UserID); err != nil {
		jsonError(w, "failed to approve registration: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{"status": "approved"}, http.StatusOK)
}

// RejectRegistration rejects a pending registration
func (h *AdminHandler) RejectRegistration(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid registration ID", http.StatusBadRequest)
		return
	}

	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	if err := h.db.RejectRegistration(id, claims.UserID); err != nil {
		jsonError(w, "failed to reject registration: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]string{"status": "rejected"}, http.StatusOK)
}

// PendingRegistrationCount returns the count of pending registrations
func (h *AdminHandler) PendingRegistrationCount(w http.ResponseWriter, r *http.Request) {
	regs, err := h.db.ListRegistrations("pending")
	if err != nil {
		jsonError(w, "failed to count registrations", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, map[string]int{"count": len(regs)}, http.StatusOK)
}

// ListSessions returns all active HLS streaming sessions
func (h *AdminHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	sessions := h.hlsManager.ListSessions()
	jsonResponse(w, sessions, http.StatusOK)
}

// DashboardStats returns system stats for the admin dashboard
func (h *AdminHandler) DashboardStats(w http.ResponseWriter, r *http.Request) {
	// GPU info (cached)
	gpuInfo := gpu.DetectGPU()

	// Disk usage for media path
	var diskTotal, diskFree, diskUsed uint64
	if h.mediaPath != "" {
		var stat syscall.Statfs_t
		if err := syscall.Statfs(h.mediaPath, &stat); err == nil {
			diskTotal = stat.Blocks * uint64(stat.Bsize)
			diskFree = stat.Bavail * uint64(stat.Bsize)
			diskUsed = diskTotal - diskFree
		}
	}

	// Memory usage
	var memStat runtime.MemStats
	runtime.ReadMemStats(&memStat)

	// Active sessions
	sessions := h.hlsManager.ListSessions()

	// User count
	users, _ := h.db.ListUsers()

	jsonResponse(w, map[string]interface{}{
		"gpu": gpuInfo,
		"storage": map[string]uint64{
			"total": diskTotal,
			"used":  diskUsed,
			"free":  diskFree,
		},
		"system": map[string]interface{}{
			"go_version":    runtime.Version(),
			"goroutines":    runtime.NumGoroutine(),
			"uptime_seconds": int(time.Since(startTime).Seconds()),
			"mem_alloc":     memStat.Alloc,
			"mem_sys":       memStat.Sys,
		},
		"active_sessions": len(sessions),
		"user_count":      len(users),
	}, http.StatusOK)
}
