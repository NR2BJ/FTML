package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/storage"
)

// extractPath extracts and URL-decodes the wildcard path from chi router
func extractPath(r *http.Request) string {
	path := chi.URLParam(r, "*")
	decoded, err := url.PathUnescape(path)
	if err != nil {
		return path
	}
	// Clean any double slashes or trailing slashes
	decoded = strings.TrimPrefix(decoded, "/")
	decoded = strings.TrimSuffix(decoded, "/")
	return decoded
}

type FilesHandler struct {
	mediaPath string
	dataPath  string
}

func NewFilesHandler(mediaPath, dataPath string) *FilesHandler {
	return &FilesHandler{mediaPath: mediaPath, dataPath: dataPath}
}

func (h *FilesHandler) GetTree(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	if path == "" {
		path = "."
	}

	entries, err := storage.ListDirectory(h.mediaPath, path)
	if err != nil {
		jsonError(w, "failed to list directory", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]interface{}{
		"path":    path,
		"entries": entries,
	}, http.StatusOK)
}

func (h *FilesHandler) GetInfo(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath := filepath.Join(h.mediaPath, path)

	if !storage.IsVideoFile(path) {
		jsonError(w, "not a video file", http.StatusBadRequest)
		return
	}

	info, err := ffmpeg.Probe(fullPath)
	if err != nil {
		jsonError(w, "failed to probe file", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, info, http.StatusOK)
}

func (h *FilesHandler) GetThumbnail(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath := filepath.Join(h.mediaPath, path)
	thumbDir := filepath.Join(h.dataPath, "thumbnails", path)

	thumbPath, err := ffmpeg.GenerateThumbnail(fullPath, thumbDir)
	if err != nil {
		jsonError(w, "failed to generate thumbnail", http.StatusInternalServerError)
		return
	}

	http.ServeFile(w, r, thumbPath)
}

func (h *FilesHandler) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		jsonError(w, "query parameter 'q' is required", http.StatusBadRequest)
		return
	}

	results, err := storage.Search(h.mediaPath, q, 50)
	if err != nil {
		jsonError(w, "search failed", http.StatusInternalServerError)
		return
	}

	jsonResponse(w, map[string]interface{}{
		"query":   q,
		"results": results,
	}, http.StatusOK)
}

// BatchInfo probes multiple files concurrently and returns their media info.
// POST /files/batch-info  body: { "paths": ["path1.mkv", "path2.mp4"] }  (max 20)
func (h *FilesHandler) BatchInfo(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if len(req.Paths) == 0 {
		jsonResponse(w, []interface{}{}, http.StatusOK)
		return
	}
	if len(req.Paths) > 20 {
		req.Paths = req.Paths[:20]
	}

	type result struct {
		Path string           `json:"path"`
		Info *ffmpeg.MediaInfo `json:"info"`
	}

	results := make([]result, len(req.Paths))
	sem := make(chan struct{}, 4) // max 4 concurrent ffprobe
	var wg sync.WaitGroup

	for i, p := range req.Paths {
		wg.Add(1)
		go func(idx int, filePath string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			fullPath := filepath.Join(h.mediaPath, filePath)
			info, err := ffmpeg.Probe(fullPath)
			if err != nil {
				results[idx] = result{Path: filePath, Info: nil}
			} else {
				results[idx] = result{Path: filePath, Info: info}
			}
		}(i, p)
	}

	wg.Wait()
	jsonResponse(w, results, http.StatusOK)
}

// safePath validates that the resolved path is within the media directory.
// Returns the absolute path and true if valid, or empty string and false if invalid.
func (h *FilesHandler) safePath(relPath string) (string, bool) {
	absMedia, _ := filepath.Abs(h.mediaPath)
	full := filepath.Join(h.mediaPath, relPath)
	absFull, _ := filepath.Abs(full)
	if !strings.HasPrefix(absFull, absMedia) {
		return "", false
	}
	return absFull, true
}

// Upload handles file upload via multipart/form-data (Admin only)
// POST /files/upload/* — the wildcard is the destination directory
func (h *FilesHandler) Upload(w http.ResponseWriter, r *http.Request) {
	destDir := extractPath(r)

	absDir, ok := h.safePath(destDir)
	if !ok {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

	// Limit upload size to 10GB
	r.Body = http.MaxBytesReader(w, r.Body, 10<<30)

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		jsonError(w, "failed to parse upload: "+err.Error(), http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		jsonError(w, "file field required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Validate filename
	filename := filepath.Base(header.Filename)
	if filename == "." || filename == ".." {
		jsonError(w, "invalid filename", http.StatusBadRequest)
		return
	}

	// Ensure destination directory exists
	if err := os.MkdirAll(absDir, 0755); err != nil {
		jsonError(w, "failed to create directory", http.StatusInternalServerError)
		return
	}

	destPath := filepath.Join(absDir, filename)

	// Create destination file
	dst, err := os.Create(destPath)
	if err != nil {
		jsonError(w, "failed to create file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil {
		os.Remove(destPath) // cleanup on failure
		jsonError(w, "failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	relPath := filepath.Join(destDir, filename)
	log.Printf("[files] Uploaded: %s (%d bytes)", relPath, written)
	jsonResponse(w, map[string]interface{}{
		"path": relPath,
		"size": written,
	}, http.StatusCreated)
}

// Delete removes a file or directory (Admin only)
// DELETE /files/delete/*
func (h *FilesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	if path == "" || path == "." {
		jsonError(w, "cannot delete root directory", http.StatusBadRequest)
		return
	}

	absPath, ok := h.safePath(path)
	if !ok {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

	// Check if target exists and is not a symlink
	info, err := os.Lstat(absPath)
	if os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}
	if err != nil {
		jsonError(w, "failed to stat file", http.StatusInternalServerError)
		return
	}

	if info.IsDir() {
		if err := os.RemoveAll(absPath); err != nil {
			jsonError(w, "failed to delete directory: "+err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		if err := os.Remove(absPath); err != nil {
			jsonError(w, "failed to delete file: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}

	log.Printf("[files] Deleted: %s", path)
	w.WriteHeader(http.StatusNoContent)
}

// Move renames or moves a file/directory (Admin only)
// PUT /files/move  body: { "source": "path/to/file", "destination": "new/path/to/file" }
func (h *FilesHandler) Move(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Source      string `json:"source"`
		Destination string `json:"destination"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Source == "" || req.Destination == "" {
		jsonError(w, "source and destination are required", http.StatusBadRequest)
		return
	}

	absSrc, ok := h.safePath(req.Source)
	if !ok {
		jsonError(w, "invalid source path", http.StatusForbidden)
		return
	}
	absDst, ok := h.safePath(req.Destination)
	if !ok {
		jsonError(w, "invalid destination path", http.StatusForbidden)
		return
	}

	// Verify source exists
	if _, err := os.Lstat(absSrc); os.IsNotExist(err) {
		jsonError(w, "source not found", http.StatusNotFound)
		return
	}

	// Ensure destination parent directory exists
	dstDir := filepath.Dir(absDst)
	if err := os.MkdirAll(dstDir, 0755); err != nil {
		jsonError(w, "failed to create destination directory", http.StatusInternalServerError)
		return
	}

	if err := os.Rename(absSrc, absDst); err != nil {
		jsonError(w, fmt.Sprintf("failed to move: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("[files] Moved: %s → %s", req.Source, req.Destination)
	jsonResponse(w, map[string]string{"status": "ok"}, http.StatusOK)
}

// CreateFolder creates a new empty directory (Admin only)
// POST /files/mkdir/*
func (h *FilesHandler) CreateFolder(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	if path == "" {
		jsonError(w, "path is required", http.StatusBadRequest)
		return
	}

	absPath, ok := h.safePath(path)
	if !ok {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

	if _, err := os.Stat(absPath); err == nil {
		jsonError(w, "path already exists", http.StatusConflict)
		return
	}

	if err := os.MkdirAll(absPath, 0755); err != nil {
		jsonError(w, "failed to create directory: "+err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("[files] Created folder: %s", path)
	jsonResponse(w, map[string]string{"path": path}, http.StatusCreated)
}
