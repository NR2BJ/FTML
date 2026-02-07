package handlers

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/ffmpeg"
)

type StreamHandler struct {
	mediaPath  string
	hlsManager *ffmpeg.HLSManager
}

func NewStreamHandler(mediaPath string, hlsManager *ffmpeg.HLSManager) *StreamHandler {
	return &StreamHandler{mediaPath: mediaPath, hlsManager: hlsManager}
}

func (h *StreamHandler) HLSHandler(w http.ResponseWriter, r *http.Request) {
	raw := chi.URLParam(r, "*")
	path, _ := url.PathUnescape(raw)

	// Check if requesting a .ts segment or .m3u8 playlist
	if strings.HasSuffix(path, ".ts") {
		h.serveSegment(w, r, path)
		return
	}

	// Treat as playlist request - strip any trailing filename to get video path
	videoPath := path
	if strings.HasSuffix(path, ".m3u8") {
		// Could be "video/path/playlist.m3u8" - strip the playlist filename
		dir := filepath.Dir(path)
		base := filepath.Base(path)
		if base == "playlist.m3u8" {
			videoPath = dir
		}
	}

	h.servePlaylist(w, r, videoPath)
}

func (h *StreamHandler) servePlaylist(w http.ResponseWriter, r *http.Request, videoPath string) {
	fullPath := filepath.Join(h.mediaPath, videoPath)

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	quality := r.URL.Query().Get("quality")
	if quality == "" {
		quality = "medium"
	}

	// "original" quality means direct play - redirect
	if quality == "original" {
		http.Redirect(w, r, "/api/stream/direct/"+videoPath, http.StatusTemporaryRedirect)
		return
	}

	sessionID := generateSessionID(videoPath, quality)

	session, err := h.hlsManager.GetOrCreateSession(sessionID, fullPath, 0, quality)
	if err != nil {
		jsonError(w, "failed to start transcoding: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Wait for playlist to be ready with at least 3 segments
	// This prevents buffer underrun at the start of playback
	playlistPath := filepath.Join(session.OutputDir, "playlist.m3u8")
	ready := false
	for i := 0; i < 100; i++ {
		data, err := os.ReadFile(playlistPath)
		if err == nil {
			// Count .ts segment lines to ensure enough buffer
			segCount := 0
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasSuffix(strings.TrimSpace(line), ".ts") {
					segCount++
				}
			}
			if segCount >= 3 {
				ready = true
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
	}

	if !ready {
		jsonError(w, "transcoding not ready", http.StatusServiceUnavailable)
		return
	}

	// Read and rewrite playlist to use correct segment URLs
	data, err := os.ReadFile(playlistPath)
	if err != nil {
		jsonError(w, "failed to read playlist", http.StatusInternalServerError)
		return
	}

	// Rewrite segment paths: "seg_00001.ts" -> "/api/stream/hls/VIDEO_PATH/seg_00001.ts?token=...&quality=..."
	token := r.URL.Query().Get("token")
	// URL-encode each path segment for the rewritten URLs
	pathParts := strings.Split(videoPath, "/")
	encodedParts := make([]string, len(pathParts))
	for i, p := range pathParts {
		encodedParts[i] = url.PathEscape(p)
	}
	encodedVideoPath := strings.Join(encodedParts, "/")

	content := string(data)
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if strings.HasSuffix(strings.TrimSpace(line), ".ts") {
			segName := strings.TrimSpace(line)
			lines[i] = fmt.Sprintf("/api/stream/hls/%s/%s?token=%s&quality=%s", encodedVideoPath, segName, token, quality)
		}
	}

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write([]byte(strings.Join(lines, "\n")))
}

func (h *StreamHandler) serveSegment(w http.ResponseWriter, r *http.Request, rawPath string) {
	path, _ := url.PathUnescape(rawPath)
	// path format: "video/folder/file.mkv/seg_00001.ts"
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		jsonError(w, "invalid segment path", http.StatusBadRequest)
		return
	}

	segmentName := parts[len(parts)-1]
	videoPath := strings.Join(parts[:len(parts)-1], "/")
	quality := r.URL.Query().Get("quality")
	if quality == "" {
		quality = "medium"
	}
	sessionID := generateSessionID(videoPath, quality)

	segmentPath := filepath.Join(h.hlsManager.GetSessionDir(sessionID), segmentName)

	// Wait for segment to be ready
	for i := 0; i < 150; i++ {
		if info, err := os.Stat(segmentPath); err == nil && info.Size() > 0 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	if _, err := os.Stat(segmentPath); os.IsNotExist(err) {
		jsonError(w, "segment not ready", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "max-age=3600")
	http.ServeFile(w, r, segmentPath)
}

func (h *StreamHandler) DirectPlay(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath := filepath.Join(h.mediaPath, path)

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	http.ServeFile(w, r, fullPath)
}

func generateSessionID(path, quality string) string {
	h := sha256.Sum256([]byte(path + "|" + quality))
	return fmt.Sprintf("%x", h[:8])
}
