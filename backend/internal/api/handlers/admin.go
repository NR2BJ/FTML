package handlers

import (
	"bufio"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
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
		log.Printf("[admin] failed to list users: %v", err)
		jsonError(w, "failed to list users", http.StatusInternalServerError)
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

	if len(req.Password) < 8 {
		jsonError(w, "password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	if !isValidUsername(req.Username) {
		jsonError(w, "username must be 1-32 characters, only letters, numbers, underscores, and hyphens", http.StatusBadRequest)
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
		if !isValidUsername(req.Username) {
			jsonError(w, "username must be 1-32 characters, only letters, numbers, underscores, and hyphens", http.StatusBadRequest)
			return
		}
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
		log.Printf("[admin] failed to update user %d: %v", id, err)
		jsonError(w, "failed to update user", http.StatusInternalServerError)
		return
	}

	// Update password if provided
	if req.Password != "" {
		if len(req.Password) < 8 {
			jsonError(w, "password must be at least 8 characters", http.StatusBadRequest)
			return
		}
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
		log.Printf("[admin] failed to delete user %d: %v", id, err)
		jsonError(w, "failed to delete user", http.StatusInternalServerError)
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
		log.Printf("[admin] failed to approve registration %d: %v", id, err)
		jsonError(w, "failed to approve registration", http.StatusInternalServerError)
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
		log.Printf("[admin] failed to reject registration %d: %v", id, err)
		jsonError(w, "failed to reject registration", http.StatusInternalServerError)
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

// DeleteRegistration removes a non-pending registration record
func (h *AdminHandler) DeleteRegistration(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		jsonError(w, "invalid registration ID", http.StatusBadRequest)
		return
	}

	if err := h.db.DeleteRegistration(id); err != nil {
		jsonError(w, "registration not found or is still pending", http.StatusNotFound)
		return
	}

	jsonResponse(w, map[string]string{"status": "ok"}, http.StatusOK)
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

	// Go process memory
	var memStat runtime.MemStats
	runtime.ReadMemStats(&memStat)

	// System RAM from /proc/meminfo
	totalMem, availMem := readMemInfo()

	// CPU info from /proc/cpuinfo
	cpuModel, cpuCores := readCPUInfo()

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
			"go_version":     runtime.Version(),
			"goroutines":     runtime.NumGoroutine(),
			"uptime_seconds": int(time.Since(startTime).Seconds()),
			"mem_alloc":      memStat.Alloc,
			"mem_sys":        memStat.Sys,
			"total_memory":   totalMem,
			"avail_memory":   availMem,
			"cpu_model":      cpuModel,
			"cpu_cores":      cpuCores,
		},
		"active_sessions": len(sessions),
		"user_count":      len(users),
	}, http.StatusOK)
}

// ListFileLogs returns recent file operation logs
func (h *AdminHandler) ListFileLogs(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 {
			limit = n
		}
	}

	logs, err := h.db.ListFileLogs(limit)
	if err != nil {
		log.Printf("[admin] failed to list file logs: %v", err)
		jsonError(w, "failed to list file logs", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, logs, http.StatusOK)
}

// readMemInfo reads system memory from /proc/meminfo
func readMemInfo() (total, avail uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			total = parseProcKB(line)
		} else if strings.HasPrefix(line, "MemAvailable:") {
			avail = parseProcKB(line)
		}
		if total > 0 && avail > 0 {
			break
		}
	}
	return total, avail
}

// parseProcKB parses a /proc line like "MemTotal:       16384 kB" and returns bytes
func parseProcKB(line string) uint64 {
	parts := strings.Fields(line)
	if len(parts) >= 2 {
		val, err := strconv.ParseUint(parts[1], 10, 64)
		if err == nil {
			return val * 1024 // kB to bytes
		}
	}
	return 0
}

// readCPUInfo reads CPU model and core count from /proc/cpuinfo
func readCPUInfo() (model string, cores int) {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return "Unknown", runtime.NumCPU()
	}
	defer f.Close()

	coreSet := make(map[string]bool)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "model name") && model == "" {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				model = strings.TrimSpace(parts[1])
			}
		}
		if strings.HasPrefix(line, "processor") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				coreSet[strings.TrimSpace(parts[1])] = true
			}
		}
	}

	if model == "" {
		model = "Unknown"
	}
	cores = len(coreSet)
	if cores == 0 {
		cores = runtime.NumCPU()
	}
	return model, cores
}
