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

func TestStoppedSessionCannotRestartFallback(t *testing.T) {
	dir := t.TempDir()
	m := &HLSManager{sessions: map[string]*HLSSession{}, baseDir: dir}
	output := filepath.Join(dir, "already-stopped")
	params := &TranscodeParams{Encoder: "h264_vaapi"}
	m.retryWithHybrid("missing", "unused.mkv", output, 0, "720p", "h264", params)
	m.retryWithSoftware("missing", "unused.mkv", output, 0, "720p", "h264", params)
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatal("stopped conversion was restarted")
	}
	m.sessions["failed"] = &HLSSession{ID: "failed", OwnerID: 1, InputPath: "video", Quality: "720p", Codec: "h264"}
	m.markFailed("failed", fmt.Errorf("test error"))
	if m.SessionFailure("failed") == "" {
		t.Fatal("failed conversion looks healthy")
	}
	if _, err := m.GetOrCreateSession("failed", 1, "video", 0, "720p", "h264", nil); err == nil {
		t.Fatal("failed session reused")
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
