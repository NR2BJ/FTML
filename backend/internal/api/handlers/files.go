package handlers

import (
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

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
