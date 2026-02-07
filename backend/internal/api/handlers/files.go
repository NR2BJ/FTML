package handlers

import (
	"encoding/json"
	"net/http"
	"net/url"
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
