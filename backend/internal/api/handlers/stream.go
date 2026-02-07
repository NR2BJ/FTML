package handlers

import (
	"crypto/sha256"
	"encoding/json"
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

// CapabilitiesHandler returns server encoder capabilities and the recommended codec
// based on the intersection with browser support.
// Query params: ?h264=true&hevc=true&av1=true&vp9=true
func (h *StreamHandler) CapabilitiesHandler(w http.ResponseWriter, r *http.Request) {
	browser := ffmpeg.BrowserCodecs{
		H264: r.URL.Query().Get("h264") == "true",
		HEVC: r.URL.Query().Get("hevc") == "true",
		AV1:  r.URL.Query().Get("av1") == "true",
		VP9:  r.URL.Query().Get("vp9") == "true",
	}

	caps := ffmpeg.GetCapabilities()
	negotiated := ffmpeg.NegotiateCodec(caps, browser)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"server_encoders":  caps.Encoders,
		"hwaccel":          caps.HWAccel,
		"device":           caps.Device,
		"selected_codec":   negotiated.Codec,
		"selected_encoder": negotiated.Encoder,
		"browser_support":  browser,
	})
}

// PresetsHandler returns the available quality presets for a given video file.
// Query params: ?codec=av1&h264=true&hevc=false&av1=true&vp9=true
func (h *StreamHandler) PresetsHandler(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath := filepath.Join(h.mediaPath, path)

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	// Parse codec and browser capabilities from query
	codec, encoder, browser := parseCodecParams(r)

	info, err := ffmpeg.Probe(fullPath)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ffmpeg.GeneratePresets(nil, codec, encoder, browser))
		return
	}

	presets := ffmpeg.GeneratePresets(info, codec, encoder, browser)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(presets)
}

func (h *StreamHandler) HLSHandler(w http.ResponseWriter, r *http.Request) {
	raw := chi.URLParam(r, "*")
	path, _ := url.PathUnescape(raw)

	// Check if requesting a segment (.ts, .m4s, init.mp4)
	if strings.HasSuffix(path, ".ts") || strings.HasSuffix(path, ".m4s") || strings.HasSuffix(path, ".mp4") {
		h.serveSegment(w, r, path)
		return
	}

	// Treat as playlist request - strip any trailing filename to get video path
	videoPath := path
	if strings.HasSuffix(path, ".m3u8") {
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
		quality = "720p"
	}

	// "original" quality means direct play - redirect
	if quality == "original" {
		http.Redirect(w, r, "/api/stream/direct/"+videoPath, http.StatusTemporaryRedirect)
		return
	}

	// Parse optional start time for seeking
	var startTime float64
	if st := r.URL.Query().Get("start"); st != "" {
		fmt.Sscanf(st, "%f", &startTime)
	}

	// Parse codec params
	codec, encoder, browser := parseCodecParams(r)

	// Probe the file to generate presets and find the matching transcode params
	info, _ := ffmpeg.Probe(fullPath)
	presets := ffmpeg.GeneratePresets(info, codec, encoder, browser)
	params := ffmpeg.GetTranscodeParams(quality, presets, encoder)

	// If quality not found in presets, use first available transcode preset
	if params == nil && quality != "original" {
		for _, p := range presets {
			if p.Value != "original" {
				params = ffmpeg.GetTranscodeParams(p.Value, presets, encoder)
				break
			}
		}
	}

	sessionID := generateSessionID(videoPath, quality, startTime, string(codec))

	// If seeking, stop any existing sessions for the same video+quality+codec at different times
	if startTime > 0 {
		h.hlsManager.StopSessionsForPath(fullPath, quality, string(codec), sessionID)
	}

	session, err := h.hlsManager.GetOrCreateSession(sessionID, fullPath, startTime, quality, string(codec), params)
	if err != nil {
		jsonError(w, "failed to start transcoding: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Wait for playlist to be ready with at least 3 segments
	playlistPath := filepath.Join(session.OutputDir, "playlist.m3u8")
	ready := false
	for i := 0; i < 100; i++ {
		data, err := os.ReadFile(playlistPath)
		if err == nil {
			segCount := 0
			for _, line := range strings.Split(string(data), "\n") {
				trimmed := strings.TrimSpace(line)
				if strings.HasSuffix(trimmed, ".ts") || strings.HasSuffix(trimmed, ".m4s") {
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

	token := r.URL.Query().Get("token")
	pathParts := strings.Split(videoPath, "/")
	encodedParts := make([]string, len(pathParts))
	for i, p := range pathParts {
		encodedParts[i] = url.PathEscape(p)
	}
	encodedVideoPath := strings.Join(encodedParts, "/")

	content := string(data)
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Handle #EXT-X-MAP:URI="init.mp4" (fmp4 init segment)
		if strings.HasPrefix(trimmed, "#EXT-X-MAP:URI=") {
			// Extract the filename from URI="..."
			uriStart := strings.Index(trimmed, `"`)
			uriEnd := strings.LastIndex(trimmed, `"`)
			if uriStart >= 0 && uriEnd > uriStart {
				segName := trimmed[uriStart+1 : uriEnd]
				segURL := fmt.Sprintf("/api/stream/hls/%s/%s?token=%s&quality=%s&codec=%s",
					encodedVideoPath, segName, token, quality, string(codec))
				if startTime > 0 {
					segURL += fmt.Sprintf("&start=%.0f", startTime)
				}
				lines[i] = fmt.Sprintf(`#EXT-X-MAP:URI="%s"`, segURL)
			}
			continue
		}

		// Handle segment lines (.ts, .m4s, .mp4)
		if strings.HasSuffix(trimmed, ".ts") || strings.HasSuffix(trimmed, ".m4s") || strings.HasSuffix(trimmed, ".mp4") {
			segName := trimmed
			segURL := fmt.Sprintf("/api/stream/hls/%s/%s?token=%s&quality=%s&codec=%s",
				encodedVideoPath, segName, token, quality, string(codec))
			if startTime > 0 {
				segURL += fmt.Sprintf("&start=%.0f", startTime)
			}
			lines[i] = segURL
		}
	}

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write([]byte(strings.Join(lines, "\n")))
}

func (h *StreamHandler) serveSegment(w http.ResponseWriter, r *http.Request, rawPath string) {
	path, _ := url.PathUnescape(rawPath)
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		jsonError(w, "invalid segment path", http.StatusBadRequest)
		return
	}

	segmentName := parts[len(parts)-1]
	videoPath := strings.Join(parts[:len(parts)-1], "/")
	quality := r.URL.Query().Get("quality")
	if quality == "" {
		quality = "720p"
	}
	codecStr := r.URL.Query().Get("codec")
	if codecStr == "" {
		codecStr = "h264"
	}
	var startTime float64
	if st := r.URL.Query().Get("start"); st != "" {
		fmt.Sscanf(st, "%f", &startTime)
	}
	sessionID := generateSessionID(videoPath, quality, startTime, codecStr)

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

	// Content-Type based on segment type
	if strings.HasSuffix(segmentName, ".m4s") || strings.HasSuffix(segmentName, ".mp4") {
		w.Header().Set("Content-Type", "video/mp4")
	} else {
		w.Header().Set("Content-Type", "video/mp2t")
	}
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

// parseCodecParams extracts codec, encoder info, and browser capabilities from request.
func parseCodecParams(r *http.Request) (ffmpeg.Codec, *ffmpeg.EncoderInfo, ffmpeg.BrowserCodecs) {
	browser := ffmpeg.BrowserCodecs{
		H264: r.URL.Query().Get("h264") != "false", // default true for h264
		HEVC: r.URL.Query().Get("hevc") == "true",
		AV1:  r.URL.Query().Get("av1") == "true",
		VP9:  r.URL.Query().Get("vp9") == "true",
	}

	codecStr := r.URL.Query().Get("codec")
	caps := ffmpeg.GetCapabilities()

	var codec ffmpeg.Codec
	var encoder *ffmpeg.EncoderInfo

	if codecStr != "" {
		codec = ffmpeg.Codec(codecStr)
		encoder = ffmpeg.GetEncoderForCodec(caps, codec)
	} else {
		// Auto-negotiate based on browser support
		negotiated := ffmpeg.NegotiateCodec(caps, browser)
		codec = negotiated.Codec
		encoder = negotiated
	}

	return codec, encoder, browser
}

func generateSessionID(path, quality string, startTime float64, codec string) string {
	key := fmt.Sprintf("%s|%s|%.0f|%s", path, quality, startTime, codec)
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("%x", h[:8])
}
