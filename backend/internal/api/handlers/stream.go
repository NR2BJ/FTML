package handlers

import (
	"crypto/sha256"
	"fmt"
	"net/http"
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

func (h *StreamHandler) HLSMaster(w http.ResponseWriter, r *http.Request) {
	path := chi.URLParam(r, "*")
	fullPath := filepath.Join(h.mediaPath, path)

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	sessionID := generateSessionID(path)

	session, err := h.hlsManager.GetOrCreateSession(sessionID, fullPath, 0)
	if err != nil {
		jsonError(w, "failed to start transcoding: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Wait for playlist to be ready
	playlistPath := filepath.Join(session.OutputDir, "playlist.m3u8")
	for i := 0; i < 50; i++ {
		if _, err := os.Stat(playlistPath); err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	http.ServeFile(w, r, playlistPath)
}

func (h *StreamHandler) HLSSegment(w http.ResponseWriter, r *http.Request) {
	path := chi.URLParam(r, "*")
	// path format: "video/path/seg_00001.ts"
	// Split into video path and segment name
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		jsonError(w, "invalid segment path", http.StatusBadRequest)
		return
	}

	segmentName := parts[len(parts)-1]
	videoPath := strings.Join(parts[:len(parts)-1], "/")
	sessionID := generateSessionID(videoPath)

	segmentPath := filepath.Join(h.hlsManager.GetSessionDir(sessionID), segmentName)

	// Wait for segment
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(segmentPath); err == nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	w.Header().Set("Content-Type", "video/mp2t")
	http.ServeFile(w, r, segmentPath)
}

func (h *StreamHandler) DirectPlay(w http.ResponseWriter, r *http.Request) {
	path := chi.URLParam(r, "*")
	fullPath := filepath.Join(h.mediaPath, path)

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	http.ServeFile(w, r, fullPath)
}

func generateSessionID(path string) string {
	h := sha256.Sum256([]byte(path))
	return fmt.Sprintf("%x", h[:8])
}
