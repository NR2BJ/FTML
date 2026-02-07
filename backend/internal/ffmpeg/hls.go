package ffmpeg

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type HLSSession struct {
	ID        string
	InputPath string
	VideoPath string // original relative path (for matching on seek)
	Quality   string
	Codec     string // "h264", "hevc", "av1", "vp9"
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

func (m *HLSManager) GetOrCreateSession(sessionID, inputPath string, startTime float64, quality, codec string, params *TranscodeParams) (*HLSSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if s, ok := m.sessions[sessionID]; ok {
		return s, nil
	}

	outputDir := filepath.Join(m.baseDir, sessionID)
	os.MkdirAll(outputDir, 0755)

	ctx, cancel := context.WithCancel(context.Background())

	// Fallback defaults if params not provided
	if params == nil {
		params = &TranscodeParams{
			Height:     1080,
			CRF:        16,
			MaxBitrate: "20M",
			BufSize:    "40M",
			VideoCodec: "h264",
			AudioCodec: "aac",
			Encoder:    "libx264",
			SegmentFmt: "mpegts",
		}
	}

	args := buildFFmpegArgs(inputPath, outputDir, startTime, params)

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	// Log FFmpeg stderr for debugging
	logFile, err := os.Create(filepath.Join(outputDir, "ffmpeg.log"))
	if err != nil {
		cmd.Stderr = os.Stderr
	} else {
		cmd.Stderr = logFile
	}

	log.Printf("[HLS] Starting transcode: session=%s codec=%s encoder=%s hwaccel=%s input=%s",
		sessionID, params.VideoCodec, params.Encoder, params.HWAccel, inputPath)

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
		Quality:   quality,
		Codec:     codec,
		OutputDir: outputDir,
		Cmd:       cmd,
		Cancel:    cancel,
		CreatedAt: time.Now(),
	}
	m.sessions[sessionID] = session

	startedAt := time.Now()
	go func() {
		err := cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
		elapsed := time.Since(startedAt)
		if err != nil {
			log.Printf("[HLS] FFmpeg exited with error: session=%s err=%v elapsed=%v", sessionID, err, elapsed)
			// Print last lines of ffmpeg.log for debugging
			logPath := filepath.Join(outputDir, "ffmpeg.log")
			if logData, readErr := os.ReadFile(logPath); readErr == nil {
				lines := strings.Split(strings.TrimSpace(string(logData)), "\n")
				start := len(lines) - 20
				if start < 0 {
					start = 0
				}
				log.Printf("[HLS] FFmpeg stderr:\n%s", strings.Join(lines[start:], "\n"))
			}

			// Auto-retry with software encoder if VAAPI failed quickly (< 5 seconds)
			if elapsed < 5*time.Second && params.HWAccel == "vaapi" {
				log.Printf("[HLS] VAAPI failed fast, retrying with software encoder: session=%s", sessionID)
				m.retryWithSoftware(sessionID, inputPath, outputDir, startTime, quality, codec, params)
			}
		} else {
			log.Printf("[HLS] FFmpeg completed: session=%s", sessionID)
		}
	}()

	return session, nil
}

// buildFFmpegArgs constructs the FFmpeg command line based on transcode params.
// Supports VAAPI hardware encoding, software encoding, and different segment formats.
func buildFFmpegArgs(inputPath, outputDir string, startTime float64, params *TranscodeParams) []string {
	args := []string{
		"-hide_banner",
		"-loglevel", "warning",
		"-analyzeduration", "20000000",
		"-probesize", "10000000",
	}

	isVAAPI := params.HWAccel == "vaapi" && params.Device != ""

	// Hardware device init for VAAPI
	if isVAAPI {
		args = append(args,
			"-hwaccel", "vaapi",
			"-hwaccel_device", params.Device,
			"-hwaccel_output_format", "vaapi",
		)
	}

	// Seek before input for fast seeking
	if startTime > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.2f", startTime))
	}

	args = append(args,
		"-i", inputPath,
		"-map", "0:v:0",
		"-map", "0:a:0?",
	)

	// Video encoder
	args = append(args, "-c:v", params.Encoder)

	// Video filter and quality settings depend on encoder type
	if isVAAPI {
		args = appendVAAPIArgs(args, params)
	} else {
		args = appendSoftwareArgs(args, params)
	}

	// Keyframe interval (consistent across codecs for HLS segment alignment)
	args = append(args, "-g", "48", "-keyint_min", "48")

	// Audio encoder — always use AAC for maximum compatibility
	args = append(args, "-c:a", "aac", "-b:a", "192k", "-ac", "2")

	// HLS output
	args = append(args, "-f", "hls", "-hls_time", "4", "-hls_list_size", "0")

	// Segment format
	if params.SegmentFmt == "fmp4" {
		args = append(args,
			"-hls_segment_type", "fmp4",
			"-hls_segment_filename", filepath.Join(outputDir, "seg_%05d.m4s"),
			"-hls_fmp4_init_filename", "init.mp4",
		)
	} else {
		args = append(args,
			"-hls_segment_filename", filepath.Join(outputDir, "seg_%05d.ts"),
		)
	}

	args = append(args,
		"-hls_flags", "independent_segments",
		"-hls_playlist_type", "event",
		"-hls_init_time", "1",
		filepath.Join(outputDir, "playlist.m3u8"),
	)

	return args
}

// appendVAAPIArgs adds VAAPI-specific video encoding arguments.
func appendVAAPIArgs(args []string, params *TranscodeParams) []string {
	// Video filter: use scale_vaapi (keeps processing on GPU)
	// format=nv12 ensures 10-bit sources are converted to 8-bit on GPU
	if params.Height > 0 {
		args = append(args, "-vf", fmt.Sprintf("scale_vaapi=w=-2:h=%d:format=nv12", params.Height))
	} else {
		args = append(args, "-vf", "scale_vaapi=format=nv12")
	}

	// Quality control for VAAPI encoders
	// VAAPI uses -global_quality for QP-based quality (not CRF)
	args = append(args,
		"-global_quality", fmt.Sprintf("%d", params.CRF),
		"-maxrate", params.MaxBitrate,
		"-bufsize", params.BufSize,
	)

	// HEVC tag for browser compatibility (Safari/Chrome)
	if params.VideoCodec == "hevc" {
		args = append(args, "-tag:v", "hvc1")
	}

	return args
}

// appendSoftwareArgs adds software encoder-specific video encoding arguments.
func appendSoftwareArgs(args []string, params *TranscodeParams) []string {
	// Video filter: standard scale filter
	filters := []string{}
	if params.Height > 0 {
		filters = append(filters, fmt.Sprintf("scale=-2:%d", params.Height))
	}
	if len(filters) > 0 {
		args = append(args, "-vf", strings.Join(filters, ","))
	}

	switch params.Encoder {
	case "libx264":
		args = append(args,
			"-preset", "veryfast",
			"-crf", fmt.Sprintf("%d", params.CRF),
			"-maxrate", params.MaxBitrate,
			"-bufsize", params.BufSize,
			"-pix_fmt", "yuv420p",
		)
	case "libx265":
		args = append(args,
			"-preset", "fast",
			"-crf", fmt.Sprintf("%d", params.CRF),
			"-maxrate", params.MaxBitrate,
			"-bufsize", params.BufSize,
			"-pix_fmt", "yuv420p",
			"-tag:v", "hvc1",
		)
	case "libsvtav1":
		args = append(args,
			"-preset", "8",
			"-crf", fmt.Sprintf("%d", params.CRF),
			"-maxrate", params.MaxBitrate,
			"-bufsize", params.BufSize,
			"-pix_fmt", "yuv420p",
		)
	case "libvpx-vp9":
		args = append(args,
			"-cpu-used", "4",
			"-crf", fmt.Sprintf("%d", params.CRF),
			"-b:v", "0",
			"-maxrate", params.MaxBitrate,
			"-bufsize", params.BufSize,
			"-pix_fmt", "yuv420p",
			"-row-mt", "1",
		)
	default:
		// Generic fallback
		args = append(args,
			"-crf", fmt.Sprintf("%d", params.CRF),
			"-maxrate", params.MaxBitrate,
			"-bufsize", params.BufSize,
		)
	}

	return args
}

// retryWithSoftware restarts a failed VAAPI session using software encoding.
func (m *HLSManager) retryWithSoftware(sessionID, inputPath, outputDir string, startTime float64, quality, codec string, origParams *TranscodeParams) {
	// Map VAAPI encoders to software fallbacks
	swEncoder := map[string]string{
		"h264_vaapi": "libx264",
		"hevc_vaapi": "libx265",
		"av1_vaapi":  "libsvtav1",
	}

	fallback, ok := swEncoder[origParams.Encoder]
	if !ok {
		log.Printf("[HLS] No software fallback for encoder %s", origParams.Encoder)
		return
	}

	// Clean up failed output
	os.RemoveAll(outputDir)
	os.MkdirAll(outputDir, 0755)

	// Build new params with software encoder
	swParams := *origParams
	swParams.Encoder = fallback
	swParams.HWAccel = ""
	swParams.Device = ""

	ctx, cancel := context.WithCancel(context.Background())
	args := buildFFmpegArgs(inputPath, outputDir, startTime, &swParams)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	logFile, err := os.Create(filepath.Join(outputDir, "ffmpeg.log"))
	if err != nil {
		cmd.Stderr = os.Stderr
	} else {
		cmd.Stderr = logFile
	}

	log.Printf("[HLS] Retrying with software: session=%s encoder=%s", sessionID, fallback)

	if err := cmd.Start(); err != nil {
		cancel()
		if logFile != nil {
			logFile.Close()
		}
		log.Printf("[HLS] Software fallback failed to start: session=%s err=%v", sessionID, err)
		return
	}

	// Update the session in-place
	m.mu.Lock()
	if s, ok := m.sessions[sessionID]; ok {
		s.Cmd = cmd
		s.Cancel = cancel
	}
	m.mu.Unlock()

	go func() {
		err := cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
		if err != nil {
			log.Printf("[HLS] Software fallback also failed: session=%s err=%v", sessionID, err)
			logPath := filepath.Join(outputDir, "ffmpeg.log")
			if logData, readErr := os.ReadFile(logPath); readErr == nil {
				lines := strings.Split(strings.TrimSpace(string(logData)), "\n")
				start := len(lines) - 20
				if start < 0 {
					start = 0
				}
				log.Printf("[HLS] FFmpeg stderr:\n%s", strings.Join(lines[start:], "\n"))
			}
		} else {
			log.Printf("[HLS] Software fallback completed: session=%s encoder=%s", sessionID, fallback)
		}
	}()
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

// StopSessionsForPath stops all sessions for a given video file, quality, and codec
// except the one with the given excludeID. Used when seeking to a new position.
func (m *HLSManager) StopSessionsForPath(inputPath, quality, codec, excludeID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, s := range m.sessions {
		if id != excludeID && s.InputPath == inputPath && s.Quality == quality && s.Codec == codec {
			s.Cancel()
			os.RemoveAll(s.OutputDir)
			delete(m.sessions, id)
			log.Printf("[HLS] Stopped old session: %s (replaced by seek)", id)
		}
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
