package ffmpeg

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type HLSSession struct {
	ID        string
	InputPath string
	OutputDir string
	Cmd       *exec.Cmd
	Cancel    context.CancelFunc
	CreatedAt time.Time
}

type HLSManager struct {
	mu       sync.RWMutex
	sessions map[string]*HLSSession
	baseDir  string
}

func NewHLSManager(baseDir string) *HLSManager {
	hlsDir := filepath.Join(baseDir, "hls")
	os.MkdirAll(hlsDir, 0755)
	m := &HLSManager{
		sessions: make(map[string]*HLSSession),
		baseDir:  hlsDir,
	}
	go m.cleanup()
	return m
}

func (m *HLSManager) GetOrCreateSession(sessionID, inputPath string, startTime float64) (*HLSSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if s, ok := m.sessions[sessionID]; ok {
		return s, nil
	}

	outputDir := filepath.Join(m.baseDir, sessionID)
	os.MkdirAll(outputDir, 0755)

	ctx, cancel := context.WithCancel(context.Background())

	args := []string{
		"-hide_banner",
		"-loglevel", "warning",
		"-analyzeduration", "20000000",
		"-probesize", "10000000",
	}

	if startTime > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.2f", startTime))
	}

	args = append(args,
		"-i", inputPath,
		"-map", "0:v:0",
		"-map", "0:a:0?",
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-crf", "23",
		"-maxrate", "15M",
		"-bufsize", "30M",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		"-b:a", "192k",
		"-ac", "2",
		"-f", "hls",
		"-hls_time", "6",
		"-hls_list_size", "0",
		"-hls_segment_filename", filepath.Join(outputDir, "seg_%05d.ts"),
		"-hls_flags", "independent_segments",
		"-hls_playlist_type", "event",
		filepath.Join(outputDir, "playlist.m3u8"),
	)

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	// Log FFmpeg stderr for debugging
	logFile, err := os.Create(filepath.Join(outputDir, "ffmpeg.log"))
	if err != nil {
		cmd.Stderr = os.Stderr
	} else {
		cmd.Stderr = logFile
	}

	log.Printf("[HLS] Starting transcode: session=%s input=%s", sessionID, inputPath)

	if err := cmd.Start(); err != nil {
		cancel()
		if logFile != nil {
			logFile.Close()
		}
		return nil, fmt.Errorf("failed to start ffmpeg: %w", err)
	}

	session := &HLSSession{
		ID:        sessionID,
		InputPath: inputPath,
		OutputDir: outputDir,
		Cmd:       cmd,
		Cancel:    cancel,
		CreatedAt: time.Now(),
	}
	m.sessions[sessionID] = session

	go func() {
		err := cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
		if err != nil {
			log.Printf("[HLS] FFmpeg exited with error: session=%s err=%v", sessionID, err)
		} else {
			log.Printf("[HLS] FFmpeg completed: session=%s", sessionID)
		}
	}()

	return session, nil
}

func (m *HLSManager) GetSessionDir(sessionID string) string {
	return filepath.Join(m.baseDir, sessionID)
}

func (m *HLSManager) StopSession(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if s, ok := m.sessions[sessionID]; ok {
		s.Cancel()
		os.RemoveAll(s.OutputDir)
		delete(m.sessions, sessionID)
	}
}

func (m *HLSManager) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		m.mu.Lock()
		for id, s := range m.sessions {
			if time.Since(s.CreatedAt) > 30*time.Minute {
				s.Cancel()
				os.RemoveAll(s.OutputDir)
				delete(m.sessions, id)
			}
		}
		m.mu.Unlock()
	}
}
