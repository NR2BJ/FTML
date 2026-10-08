package ffmpeg

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionOwnershipAndLifetime(t *testing.T) {
	now := time.Now()
	cancelled := false
	m := &HLSManager{sessions: map[string]*HLSSession{}, baseDir: t.TempDir()}
	m.sessions["viewer-a"] = &HLSSession{
		ID: "viewer-a", OwnerID: 12, InputPath: "episode.mkv", Quality: "720p", Codec: "h264",
		OutputDir: filepath.Join(m.baseDir, "viewer-a"), CreatedAt: now.Add(-3 * time.Hour), LastHeartbeat: now,
		Cancel: func() { cancelled = true },
	}
	if !m.OwnsSession("viewer-a", 12) || m.OwnsSession("viewer-a", 13) {
		t.Fatal("owner check failed")
	}
	if _, err := m.GetOrCreateSession("viewer-a", 13, "episode.mkv", 0, "720p", "h264", nil); err == nil {
		t.Fatal("another user reused session")
	}
	if _, err := m.GetOrCreateSession("viewer-a", 12, "other.mkv", 0, "720p", "h264", nil); err == nil {
		t.Fatal("session changed input")
	}
	m.cleanupAt(now)
	if cancelled || !m.OwnsSession("viewer-a", 12) {
		t.Fatal("active long playback was removed")
	}
	m.cleanupAt(now.Add(3 * time.Minute))
	if !cancelled || m.OwnsSession("viewer-a", 12) {
		t.Fatal("abandoned session was retained")
	}
}

func TestFailedSessionCannotRewritePublishedOutput(t *testing.T) {
	dir := t.TempDir()
	m := &HLSManager{sessions: map[string]*HLSSession{}, baseDir: dir}
	output := filepath.Join(dir, "published.m4s")
	os.WriteFile(output, []byte("already served"), 0600)
	m.sessions["failed"] = &HLSSession{ID: "failed", OwnerID: 1, InputPath: "video", Quality: "720p", Codec: "h264"}
	m.markFailed("failed", fmt.Errorf("test error"))
	if m.SessionFailure("failed") == "" {
		t.Fatal("failed conversion looks healthy")
	}
	if _, err := m.GetOrCreateSession("failed", 1, "video", 0, "720p", "h264", nil); err == nil {
		t.Fatal("failed session reused")
	}
	data, _ := os.ReadFile(output)
	if string(data) != "already served" {
		t.Fatal("published segment rewritten")
	}
	if status, ok := m.PlaybackStatus("failed", 1); !ok || status.State != "failed" {
		t.Fatal("failure not observable")
	}
	if _, ok := m.PlaybackStatus("failed", 2); ok {
		t.Fatal("another user read playback state")
	}
}

func TestRetiredAndStaleDiskSessionCannotRestart(t *testing.T) {
	m := &HLSManager{sessions: map[string]*HLSSession{}, baseDir: t.TempDir()}
	m.sessions["retired"] = &HLSSession{ID: "retired"}
	m.StopSession("retired")
	if _, err := m.GetOrCreateSession("retired", 1, "video", 0, "720p", "h264", nil); err == nil {
		t.Fatal("retired session restarted")
	}
	os.Mkdir(filepath.Join(m.baseDir, "stale"), 0700)
	if _, err := m.GetOrCreateSession("stale", 1, "video", 0, "720p", "h264", nil); err == nil {
		t.Fatal("stale disk segments reused")
	}
}

func TestReadAheadHysteresis(t *testing.T) {
	s := &HLSSession{ID: "test", Position: 100, OutputTime: 191}
	m := &HLSManager{sessions: map[string]*HLSSession{"test": s}}
	m.updateThrottle(s)
	if !s.Throttled {
		t.Fatal("unbounded read ahead")
	}
	m.UpdatePosition("test", 130)
	if !s.Throttled {
		t.Fatal("resumed without hysteresis")
	}
	m.UpdatePosition("test", 150)
	if s.Throttled {
		t.Fatal("never resumed")
	}
	s.Paused = true
	m.UpdatePosition("test", 200)
	if !s.Paused {
		t.Fatal("read ahead changed user pause")
	}
}

func TestClosedManagerRejectsNewWork(t *testing.T) {
	m := NewHLSManager(t.TempDir())
	m.Close()
	m.Close()
	if _, err := m.GetOrCreateSession("new", 1, "video", 0, "720p", "h264", nil); err == nil {
		t.Fatal("started work during shutdown")
	}
}

func TestLowResolutionVideoHasTranscodeOption(t *testing.T) {
	options := GeneratePresets(&MediaInfo{Height: 360, Width: 640, VideoCodec: "prores", Container: "mov"}, CodecH264, nil, BrowserCodecs{H264: true, AAC: true})
	for _, option := range options {
		if option.Value == "360p" && option.Height == 360 && option.VideoCodec == "h264" {
			return
		}
	}
	t.Fatal("low resolution video has no compatible transcode option")
}
