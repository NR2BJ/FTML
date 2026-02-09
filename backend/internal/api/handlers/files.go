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
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/db"
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
	db        *db.Database
}

func NewFilesHandler(mediaPath, dataPath string, database ...*db.Database) *FilesHandler {
	h := &FilesHandler{mediaPath: mediaPath, dataPath: dataPath}
	if len(database) > 0 {
		h.db = database[0]
	}
	return h
}

// logFileOp records a file operation if db is available
func (h *FilesHandler) logFileOp(r *http.Request, action, filePath, detail string) {
	if h.db == nil {
		return
	}
	claims := middleware.GetClaims(r)
	if claims == nil {
		return
	}
	if err := h.db.CreateFileLog(claims.UserID, claims.Username, action, filePath, detail); err != nil {
		log.Printf("[files] failed to log file operation: %v", err)
	}
}

// trashDir returns the path to the .trash directory inside mediaPath
func (h *FilesHandler) trashDir() string {
	return filepath.Join(h.mediaPath, ".trash")
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

// GetSiblings returns video files in the same directory as the given file, naturally sorted.
// GET /files/siblings/* — returns { current: "name.mkv", files: ["a.mkv", "b.mkv", ...] }
func (h *FilesHandler) GetSiblings(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	if path == "" {
		jsonError(w, "path is required", http.StatusBadRequest)
		return
	}

	dir := filepath.Dir(path)
	if dir == "." {
		dir = ""
	}
	baseName := filepath.Base(path)

	entries, err := storage.ListDirectory(h.mediaPath, dir)
	if err != nil {
		jsonError(w, "failed to list directory", http.StatusInternalServerError)
		return
	}

	// Filter to video files only and naturally sort
	var videoFiles []string
	for _, e := range entries {
		if !e.IsDir && storage.IsVideoFile(e.Name) {
			videoFiles = append(videoFiles, e.Name)
		}
	}
	sort.Slice(videoFiles, func(i, j int) bool {
		return naturalLess(videoFiles[i], videoFiles[j])
	})

	jsonResponse(w, map[string]interface{}{
		"current": baseName,
		"dir":     dir,
		"files":   videoFiles,
	}, http.StatusOK)
}

// naturalLess performs a natural sort comparison (e.g., "ep2" < "ep10")
func naturalLess(a, b string) bool {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	ia, ib := 0, 0
	for ia < len(la) && ib < len(lb) {
		ca, cb := la[ia], lb[ib]
		if isDigit(ca) && isDigit(cb) {
			// Compare numeric segments
			na, ea := extractNumber(la, ia)
			nb, eb := extractNumber(lb, ib)
			if na != nb {
				return na < nb
			}
			ia, ib = ea, eb
		} else {
			if ca != cb {
				return ca < cb
			}
			ia++
			ib++
		}
	}
	return len(la) < len(lb)
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func extractNumber(s string, start int) (int, int) {
	end := start
	for end < len(s) && isDigit(s[end]) {
		end++
	}
	n := 0
	for i := start; i < end; i++ {
		n = n*10 + int(s[i]-'0')
	}
	return n, end
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
		jsonError(w, "failed to parse upload", http.StatusBadRequest)
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
		log.Printf("[files] failed to create file %s: %v", destPath, err)
		jsonError(w, "failed to create file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil {
		os.Remove(destPath) // cleanup on failure
		log.Printf("[files] failed to write file %s: %v", destPath, err)
		jsonError(w, "failed to write file", http.StatusInternalServerError)
		return
	}

	relPath := filepath.Join(destDir, filename)
	log.Printf("[files] Uploaded: %s (%d bytes)", relPath, written)
	h.logFileOp(r, "upload", relPath, fmt.Sprintf("%d bytes", written))
	jsonResponse(w, map[string]interface{}{
		"path": relPath,
		"size": written,
	}, http.StatusCreated)
}

// Delete moves a file or directory to trash (Admin only)
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

	// Check if target exists
	_, err := os.Lstat(absPath)
	if os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}
	if err != nil {
		jsonError(w, "failed to stat file", http.StatusInternalServerError)
		return
	}

	// Move to trash instead of permanent deletion
	trashDir := h.trashDir()
	if err := os.MkdirAll(trashDir, 0755); err != nil {
		jsonError(w, "failed to create trash directory", http.StatusInternalServerError)
		return
	}

	baseName := filepath.Base(absPath)
	timestamp := time.Now().Format("20060102_150405")
	trashName := fmt.Sprintf("%s_%s", timestamp, baseName)
	trashPath := filepath.Join(trashDir, trashName)

	// Write metadata
	meta := map[string]string{
		"original_path": path,
		"deleted_at":    time.Now().Format(time.RFC3339),
		"deleted_by":    "",
	}
	claims := middleware.GetClaims(r)
	if claims != nil {
		meta["deleted_by"] = claims.Username
	}
	metaBytes, _ := json.Marshal(meta)
	metaPath := trashPath + ".meta.json"
	if err := os.WriteFile(metaPath, metaBytes, 0644); err != nil {
		log.Printf("[files] failed to write trash metadata: %v", err)
	}

	// Move file/directory to trash
	if err := os.Rename(absPath, trashPath); err != nil {
		log.Printf("[files] failed to move to trash %s: %v", absPath, err)
		jsonError(w, "failed to move to trash", http.StatusInternalServerError)
		return
	}

	log.Printf("[files] Moved to trash: %s → %s", path, trashName)
	h.logFileOp(r, "delete", path, "moved to trash")
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
		log.Printf("[files] failed to move %s → %s: %v", absSrc, absDst, err)
		jsonError(w, "failed to move", http.StatusInternalServerError)
		return
	}

	log.Printf("[files] Moved: %s → %s", req.Source, req.Destination)
	h.logFileOp(r, "move", req.Source, fmt.Sprintf("→ %s", req.Destination))
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
		log.Printf("[files] failed to create directory %s: %v", absPath, err)
		jsonError(w, "failed to create directory", http.StatusInternalServerError)
		return
	}

	log.Printf("[files] Created folder: %s", path)
	h.logFileOp(r, "mkdir", path, "")
	jsonResponse(w, map[string]string{"path": path}, http.StatusCreated)
}

// --- Trash handlers ---

// TrashEntry represents a file in the trash
type TrashEntry struct {
	Name         string `json:"name"`
	OriginalPath string `json:"original_path"`
	DeletedAt    string `json:"deleted_at"`
	DeletedBy    string `json:"deleted_by"`
	IsDir        bool   `json:"is_dir"`
	Size         int64  `json:"size"`
}

// ListTrash returns all items in the trash
func (h *FilesHandler) ListTrash(w http.ResponseWriter, r *http.Request) {
	trashDir := h.trashDir()

	entries, err := os.ReadDir(trashDir)
	if err != nil {
		if os.IsNotExist(err) {
			jsonResponse(w, []TrashEntry{}, http.StatusOK)
			return
		}
		jsonError(w, "failed to read trash", http.StatusInternalServerError)
		return
	}

	var items []TrashEntry
	for _, e := range entries {
		// Skip .meta.json files
		if strings.HasSuffix(e.Name(), ".meta.json") {
			continue
		}

		entry := TrashEntry{Name: e.Name(), IsDir: e.IsDir()}

		// Read file size
		info, err := e.Info()
		if err == nil {
			entry.Size = info.Size()
		}

		// Read metadata
		metaPath := filepath.Join(trashDir, e.Name()+".meta.json")
		if metaData, err := os.ReadFile(metaPath); err == nil {
			var meta map[string]string
			if json.Unmarshal(metaData, &meta) == nil {
				entry.OriginalPath = meta["original_path"]
				entry.DeletedAt = meta["deleted_at"]
				entry.DeletedBy = meta["deleted_by"]
			}
		}

		items = append(items, entry)
	}

	if items == nil {
		items = []TrashEntry{}
	}

	// Sort by deletion time (newest first — filenames are timestamp-prefixed)
	sort.Slice(items, func(i, j int) bool {
		return items[i].Name > items[j].Name
	})

	jsonResponse(w, items, http.StatusOK)
}

// RestoreTrash restores an item from trash to its original location
func (h *FilesHandler) RestoreTrash(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		jsonError(w, "name is required", http.StatusBadRequest)
		return
	}

	trashDir := h.trashDir()
	trashPath := filepath.Join(trashDir, req.Name)

	// Verify it exists in trash
	if _, err := os.Lstat(trashPath); os.IsNotExist(err) {
		jsonError(w, "item not found in trash", http.StatusNotFound)
		return
	}

	// Read metadata for original path
	metaPath := trashPath + ".meta.json"
	var originalPath string
	if metaData, err := os.ReadFile(metaPath); err == nil {
		var meta map[string]string
		if json.Unmarshal(metaData, &meta) == nil {
			originalPath = meta["original_path"]
		}
	}

	if originalPath == "" {
		jsonError(w, "cannot determine original path", http.StatusInternalServerError)
		return
	}

	destPath := filepath.Join(h.mediaPath, originalPath)

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
		jsonError(w, "failed to create parent directory", http.StatusInternalServerError)
		return
	}

	// Check if destination already exists
	if _, err := os.Lstat(destPath); err == nil {
		jsonError(w, "a file already exists at the original location", http.StatusConflict)
		return
	}

	// Move back
	if err := os.Rename(trashPath, destPath); err != nil {
		log.Printf("[files] failed to restore from trash: %v", err)
		jsonError(w, "failed to restore file", http.StatusInternalServerError)
		return
	}

	// Remove metadata file
	os.Remove(metaPath)

	log.Printf("[files] Restored from trash: %s → %s", req.Name, originalPath)
	h.logFileOp(r, "restore", originalPath, "restored from trash")
	jsonResponse(w, map[string]string{"status": "ok", "restored_to": originalPath}, http.StatusOK)
}

// PermanentDelete permanently removes an item from trash
func (h *FilesHandler) PermanentDelete(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		jsonError(w, "name is required", http.StatusBadRequest)
		return
	}

	trashDir := h.trashDir()
	trashPath := filepath.Join(trashDir, name)

	// Verify it exists in trash
	info, err := os.Lstat(trashPath)
	if os.IsNotExist(err) {
		jsonError(w, "item not found in trash", http.StatusNotFound)
		return
	}

	// Remove the file/directory
	if info.IsDir() {
		if err := os.RemoveAll(trashPath); err != nil {
			jsonError(w, "failed to permanently delete", http.StatusInternalServerError)
			return
		}
	} else {
		if err := os.Remove(trashPath); err != nil {
			jsonError(w, "failed to permanently delete", http.StatusInternalServerError)
			return
		}
	}

	// Remove metadata
	os.Remove(trashPath + ".meta.json")

	log.Printf("[files] Permanently deleted from trash: %s", name)
	h.logFileOp(r, "permanent_delete", name, "permanently deleted from trash")
	w.WriteHeader(http.StatusNoContent)
}

// EmptyTrash permanently removes all items from trash
func (h *FilesHandler) EmptyTrash(w http.ResponseWriter, r *http.Request) {
	trashDir := h.trashDir()

	if err := os.RemoveAll(trashDir); err != nil {
		jsonError(w, "failed to empty trash", http.StatusInternalServerError)
		return
	}

	log.Printf("[files] Trash emptied")
	h.logFileOp(r, "empty_trash", ".trash", "all items permanently deleted")
	jsonResponse(w, map[string]string{"status": "ok"}, http.StatusOK)
}
