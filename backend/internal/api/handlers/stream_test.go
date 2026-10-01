package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/ffmpeg"
)

func TestMediaPathDecodesExactlyOnce(t *testing.T) {
	for _, path := range []string{"video 100%.mp4", "folder/literal%20name#1?.mp4", "애니/日本語.mp4", "folder/%2Fnot-a-slash.mp4"} {
		router := chi.NewRouter()
		router.Get("/file/*", func(w http.ResponseWriter, r *http.Request) {
			if got := extractPath(r); got != path {
				t.Errorf("path %q became %q", path, got)
			}
		})
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/file/"+escapeMediaPath(path), nil))
	}
}

func TestRejectInvalidPlaybackParameters(t *testing.T) {
	h := NewStreamHandler(t.TempDir(), nil)
	router := chi.NewRouter()
	router.Get("/hls/*", h.HLSHandler)
	for _, query := range []string{"session=../bad", "session=" + strings.Repeat("a", 32) + "&audio=-1", "session=" + strings.Repeat("a", 32) + "&start=NaN", "session=" + strings.Repeat("a", 32) + "&start=1oops"} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("GET", "/hls/movie.mp4/playlist.m3u8?"+query, nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid request: %s got %d", query, w.Code)
		}
	}
}

func TestHEVCMain10CapabilityIsExplicit(t *testing.T) {
	for _, query := range []string{"hevc=true", "hevc=true&hevc10=false", "hevc=true&hevc10=true"} {
		_, _, browser := parseCodecParams(httptest.NewRequest("GET", "/presets/video.mkv?"+query, nil))
		if !browser.HEVC || browser.HEVC10 != strings.Contains(query, "hevc10=true") {
			t.Fatalf("wrong profile support for %s: %+v", query, browser)
		}
	}
}

func TestHLSPlaylistAndOwnedSegments(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg unavailable")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe unavailable")
	}
	dir := t.TempDir()
	name := "episode %20 #1?.mp4"
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=128x96:r=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-c:a", "ac3", filepath.Join(dir, name))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	manager := ffmpeg.NewHLSManager(t.TempDir())
	h := NewStreamHandler(dir, manager)
	sid := strings.Repeat("b", 32)
	t.Cleanup(func() { manager.StopSession(sid) })
	router := chi.NewRouter()
	router.Get("/api/stream/hls/*", h.HLSHandler)
	router.Post("/api/stream/heartbeat/{sessionID}", h.HeartbeatHandler)
	router.Delete("/api/stream/session/{sessionID}", h.StopSessionHandler)
	request := func(method, path string, userID int64) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil).WithContext(context.WithValue(ctx, middleware.UserClaimsKey, &auth.Claims{UserID: userID}))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	w := request("GET", "/api/stream/hls/"+escapeMediaPath(name)+"/playlist.m3u8?session="+sid+"&quality=passthrough&codec=h264&start=0.125", 12)
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Body.String(), "#EXTM3U") {
		t.Fatalf("playlist: %d %s", w.Code, w.Body.String())
	}
	var segmentURL string
	for _, line := range strings.Split(w.Body.String(), "\n") {
		if strings.HasPrefix(line, "/api/") {
			segmentURL = line
			break
		}
	}
	if segmentURL == "" {
		t.Fatal("no media segment")
	}
	if w := request("GET", segmentURL, 13); w.Code != http.StatusNotFound {
		t.Fatalf("other user read segment: %d", w.Code)
	}
	if w := request("GET", segmentURL, 12); w.Code != http.StatusOK || w.Body.Len() == 0 {
		t.Fatalf("owned segment: %d %s", w.Code, w.Body.String())
	}
	if w := request("POST", "/api/stream/heartbeat/"+sid, 13); w.Code != http.StatusNotFound {
		t.Fatal("other user heartbeated")
	}
	if w := request("DELETE", "/api/stream/session/"+sid, 13); w.Code != http.StatusNotFound {
		t.Fatal("other user stopped playback")
	}
	if !manager.OwnsSession(sid, 12) {
		t.Fatal("session lost")
	}
	secondID := strings.Repeat("c", 32)
	t.Cleanup(func() { manager.StopSession(secondID) })
	w = request("GET", "/api/stream/hls/"+escapeMediaPath(name)+"/playlist.m3u8?session="+secondID+"&quality=360p&codec=h264", 13)
	if w.Code != http.StatusOK {
		t.Fatalf("CPU transcode: %d %s", w.Code, w.Body.String())
	}
	if w := request("DELETE", "/api/stream/session/"+sid, 12); w.Code != http.StatusNoContent {
		t.Fatal("owner could not stop playback")
	}
	if !manager.OwnsSession(secondID, 13) {
		t.Fatal("stopping one viewer interrupted another")
	}
}
