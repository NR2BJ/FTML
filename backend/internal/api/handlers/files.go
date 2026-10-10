package handlers

import (
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/storage"
)

// extractPath extracts and URL-decodes the wildcard path from chi router
func extractPath(r *http.Request) string {
	path := chi.URLParam(r, "*")
	decoded := path
	// chi routes on RawPath when present, otherwise URL.Path is already decoded.
	if r.URL.RawPath != "" {
		if value, err := url.PathUnescape(path); err == nil {
			decoded = value
		}
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
	fullPath, ok := h.safePath(path)
	if !ok {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

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
	fullPath, ok := h.safePath(path)
	if !ok {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}
	thumbDir := filepath.Join(h.dataPath, "thumbnails", filepath.Clean(path))

	thumbPath, err := ffmpeg.GenerateThumbnail(fullPath, thumbDir)
	if err != nil {
		jsonError(w, "failed to generate thumbnail", http.StatusInternalServerError)
		return
	}

	http.ServeFile(w, r, thumbPath)
}

func (h *FilesHandler) Search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		jsonError(w, "query parameter 'q' is required", http.StatusBadRequest)
		return
	}
	if len([]rune(q)) < 2 {
		jsonError(w, "query must be at least 2 characters", http.StatusBadRequest)
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
		Path string            `json:"path"`
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

			fullPath, ok := h.safePath(filePath)
			if !ok {
				results[idx] = result{Path: filePath, Info: nil}
				return
			}
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
	absFull, err := storage.ResolveWithinBase(h.mediaPath, relPath)
	if err != nil {
		return "", false
	}
	return absFull, true
}
