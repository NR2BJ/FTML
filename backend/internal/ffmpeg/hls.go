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
	"syscall"
	"time"
)

type HLSSession struct {
	ID            string
	InputPath     string
	VideoPath     string // original relative path (for matching on seek)
	Quality       string
	Codec         string // "h264", "hevc", "av1", "vp9"
	OutputDir     string
	Cmd           *exec.Cmd
	Cancel        context.CancelFunc
	CreatedAt     time.Time
	LastHeartbeat time.Time // last heartbeat from client
	Stopped       bool      // set true before intentional cancel to prevent false SW fallback
	Paused        bool      // true when FFmpeg is frozen via SIGSTOP
	PausedAt      time.Time // when the session was paused
	FFmpegDone    bool      // true after FFmpeg process exits (all segments written)
}

type HLSManager struct {
	mu       sync.RWMutex
	sessions map[string]*HLSSession
	baseDir  string
	// fallbackCache remembers which sessions had to fall back to software encoding.
	// When a session is re-created (e.g. after heartbeat timeout), we skip VAAPI
	// and go straight to the cached SW encoder to avoid the VAAPI→fail→SW→timeout loop.
	fallbackCache     map[string]string    // sessionID → SW encoder name
	fallbackCacheTime map[string]time.Time // sessionID → when the entry was added
}

// logFFmpegTail prints the last 20 lines of the ffmpeg.log file for debugging.
func logFFmpegTail(outputDir, sessionID string) {
	logPath := filepath.Join(outputDir, "ffmpeg.log")
	logData, err := os.ReadFile(logPath)
	if err != nil {
		return
	}
	lines := strings.Split(strings.TrimSpace(string(logData)), "\n")
	start := len(lines) - 20
	if start < 0 {
		start = 0
	}
	log.Printf("[HLS] FFmpeg stderr:\n%s", strings.Join(lines[start:], "\n"))
}

// isSessionStopped checks whether a session was intentionally stopped.
func (m *HLSManager) isSessionStopped(sessionID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, exists := m.sessions[sessionID]
	return !exists || s.Stopped
}

// resetOutputDir removes and recreates the output directory.
func resetOutputDir(dir string) {
	os.RemoveAll(dir)
	os.MkdirAll(dir, 0755)
}

func NewHLSManager(baseDir string) *HLSManager {
	hlsDir := filepath.Join(baseDir, "hls")
	os.MkdirAll(hlsDir, 0755)
	m := &HLSManager{
		sessions:          make(map[string]*HLSSession),
		baseDir:           hlsDir,
		fallbackCache:     make(map[string]string),
		fallbackCacheTime: make(map[string]time.Time),
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

	// Check if this session previously failed and fell back to hybrid or software.
	// Apply the cached fallback state to avoid repeating the failed path.
	// Cache values: "hybrid:<vaapi_encoder>" or "sw:<sw_encoder>"
	if params != nil && params.HWAccel != "" {
		if fallbackState, ok := m.fallbackCache[sessionID]; ok {
			if strings.HasPrefix(fallbackState, "hybrid:") {
				// Hybrid: CPU decode + GPU encode. Keep VAAPI encoder and device.
				encoder := strings.TrimPrefix(fallbackState, "hybrid:")
				log.Printf("[HLS] Using cached hybrid fallback: encoder=%s (CPU decode + GPU encode) session=%s", encoder, sessionID)
				params.Encoder = encoder
				params.HWAccel = "" // Disable VAAPI decode
				// params.Device stays (needed for -init_hw_device and hwupload)
			} else if strings.HasPrefix(fallbackState, "sw:") {
				// Full software: switch encoder, clear all hardware
				encoder := strings.TrimPrefix(fallbackState, "sw:")
				log.Printf("[HLS] Using cached SW fallback: encoder=%s (skipping VAAPI) session=%s", encoder, sessionID)
				params.Encoder = encoder
				params.HWAccel = ""
				params.Device = ""
			} else {
				// Legacy format (bare encoder name) — treat as SW fallback
				log.Printf("[HLS] Using cached SW fallback (legacy): encoder=%s session=%s", fallbackState, sessionID)
				params.Encoder = fallbackState
				params.HWAccel = ""
				params.Device = ""
			}
		}
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

	now := time.Now()
	session := &HLSSession{
		ID:            sessionID,
		InputPath:     inputPath,
		Quality:       quality,
		Codec:         codec,
		OutputDir:     outputDir,
		Cmd:           cmd,
		Cancel:        cancel,
		CreatedAt:     now,
		LastHeartbeat: now,
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
			logFFmpegTail(outputDir, sessionID)

			// Auto-retry with software encoder if VAAPI failed quickly (< 5 seconds)
			// But skip if the session was intentionally stopped (seek, quality switch, cleanup)
			wasStopped := m.isSessionStopped(sessionID)

			if !wasStopped && elapsed < 5*time.Second && params.HWAccel == "vaapi" {
				log.Printf("[HLS] VAAPI failed fast, retrying with hybrid (CPU decode + GPU encode): session=%s", sessionID)
				m.retryWithHybrid(sessionID, inputPath, outputDir, startTime, quality, codec, params)
			} else if wasStopped {
				log.Printf("[HLS] Session was intentionally stopped, skipping SW fallback: session=%s", sessionID)
			}
		} else {
			log.Printf("[HLS] FFmpeg completed: session=%s", sessionID)
			// Mark session as done so cleanup uses a longer timeout
			m.mu.Lock()
			if s, ok := m.sessions[sessionID]; ok {
				s.FFmpegDone = true
			}
			m.mu.Unlock()
		}
	}()

	return session, nil
}

// buildFFmpegArgs constructs the FFmpeg command line based on transcode params.
// Supports VAAPI hardware encoding, software encoding, video passthrough (copy),
// and different segment formats.
func buildFFmpegArgs(inputPath, outputDir string, startTime float64, params *TranscodeParams) []string {
	args := []string{
		"-hide_banner",
		"-loglevel", "warning",
		"-analyzeduration", "20000000",
		"-probesize", "10000000",
	}

	isPassthrough := params.VideoCodec == "copy" || params.Encoder == "copy"
	isVAAPI := !isPassthrough && params.HWAccel == "vaapi" && params.Device != ""
	// Hybrid mode: CPU decode + GPU encode. Detected when HWAccel is cleared
	// but Device is kept and encoder is still a VAAPI encoder (e.g. av1_vaapi).
	isHybrid := !isPassthrough && !isVAAPI && params.Device != "" && strings.HasSuffix(params.Encoder, "_vaapi")

	// Hardware device init for VAAPI (skip for passthrough)
	if isVAAPI {
		args = append(args,
			"-hwaccel", "vaapi",
			"-hwaccel_device", params.Device,
			"-hwaccel_output_format", "vaapi",
		)
	} else if isHybrid {
		// Hybrid: CPU decodes, but GPU is needed for encoding and hwupload filter.
		// -init_hw_device creates the VAAPI device, -filter_hw_device makes it
		// available to filters (hwupload) without requiring hwaccel decode.
		args = append(args,
			"-init_hw_device", fmt.Sprintf("vaapi=hw:%s", params.Device),
			"-filter_hw_device", "hw",
		)
	}

	// Seek before input for fast seeking
	if startTime > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.2f", startTime))
	}

	// Audio stream mapping: use the specified audio stream index
	audioMap := fmt.Sprintf("0:a:%d?", params.AudioStreamIndex)

	args = append(args,
		"-i", inputPath,
		"-map", "0:v:0",
		"-map", audioMap,
	)

	if isPassthrough {
		// Video passthrough: copy video stream as-is, only transcode audio
		args = append(args, "-c:v", "copy")
		// Fix negative packet duration / DTS warnings in MKV→fMP4 remux.
		// Without this, MSE may refuse to play the first segments on initial load.
		args = append(args, "-avoid_negative_ts", "make_zero")
		args = append(args, "-fflags", "+genpts+igndts")
		args = append(args, "-max_interleave_delta", "0")
		// Reset PTS to 0-based. MKV files often have non-zero first PTS (5-10s offset).
		// In copy mode, -output_ts_offset alone doesn't work because packets keep original PTS.
		// The setts bitstream filter rewrites PTS/DTS at the packet level before muxing.
		args = append(args, "-bsf:v", "setts=pts=PTS-STARTPTS:dts=DTS-STARTPTS")
		// Audio sync: force audio PTS to align with video.
		// Without this, video PTS is reset to 0 by setts but audio keeps the original
		// MKV offset, causing A/V desync in passthrough mode.
		args = append(args, "-af", "aresample=async=1")
		// fMP4 HLS requires codec tags for browser MSE compatibility
		if params.SourceVideoCodec == "hevc" {
			args = append(args, "-tag:v", "hvc1")
		} else if params.SourceVideoCodec == "h264" {
			args = append(args, "-tag:v", "avc1")
		}
	} else {
		// Video encoder
		args = append(args, "-c:v", params.Encoder)

		// Video filter and quality settings depend on encoder type
		if isVAAPI {
			args = appendVAAPIArgs(args, params)
		} else if isHybrid {
			args = appendHybridArgs(args, params)
		} else {
			args = appendSoftwareArgs(args, params)
		}

		// Keyframe interval (consistent across codecs for HLS segment alignment)
		args = append(args, "-g", "48", "-keyint_min", "48")
	}

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

// appendHybridArgs adds arguments for hybrid mode (CPU decode + GPU encode).
// The filter chain scales on CPU, converts to nv12, then uploads to VAAPI for encoding.
func appendHybridArgs(args []string, params *TranscodeParams) []string {
	// Filter chain: CPU scale → format nv12 → hwupload to VAAPI device
	if params.Height > 0 {
		args = append(args, "-vf", fmt.Sprintf("scale=-2:%d,format=nv12,hwupload", params.Height))
	} else {
		args = append(args, "-vf", "format=nv12,hwupload")
	}

	// Quality control: same as VAAPI (QP-based via -global_quality)
	args = append(args,
		"-global_quality", fmt.Sprintf("%d", params.CRF),
		"-maxrate", params.MaxBitrate,
		"-bufsize", params.BufSize,
	)

	// HEVC tag for browser compatibility
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
		// Constrained quality: CRF sets quality floor, -b:v sets bitrate ceiling
		args = append(args,
			"-cpu-used", "4",
			"-crf", fmt.Sprintf("%d", params.CRF),
			"-b:v", params.MaxBitrate,
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

// retryWithHybrid restarts a failed VAAPI session using hybrid mode
// (CPU decode + GPU encode). This is tried before full software fallback
// because GPU encoding is much faster than CPU encoding.
func (m *HLSManager) retryWithHybrid(sessionID, inputPath, outputDir string, startTime float64, quality, codec string, origParams *TranscodeParams) {
	resetOutputDir(outputDir)

	// Build hybrid params: keep VAAPI encoder + device, clear hwaccel decode
	hybridParams := *origParams
	hybridParams.HWAccel = "" // Disable GPU decode (CPU will decode)
	// hybridParams.Device stays (needed for -init_hw_device and hwupload filter)
	// hybridParams.Encoder stays (e.g. av1_vaapi — GPU encodes)

	ctx, cancel := context.WithCancel(context.Background())
	args := buildFFmpegArgs(inputPath, outputDir, startTime, &hybridParams)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	logFile, err := os.Create(filepath.Join(outputDir, "ffmpeg.log"))
	if err != nil {
		cmd.Stderr = os.Stderr
	} else {
		cmd.Stderr = logFile
	}

	log.Printf("[HLS] Retrying with hybrid (CPU decode + GPU encode): session=%s encoder=%s", sessionID, hybridParams.Encoder)

	if err := cmd.Start(); err != nil {
		cancel()
		if logFile != nil {
			logFile.Close()
		}
		log.Printf("[HLS] Hybrid fallback failed to start, trying full SW: session=%s err=%v", sessionID, err)
		m.retryWithSoftware(sessionID, inputPath, outputDir, startTime, quality, codec, origParams)
		return
	}

	// Update the session in-place and register in fallback cache
	m.mu.Lock()
	if s, ok := m.sessions[sessionID]; ok {
		s.Cmd = cmd
		s.Cancel = cancel
		s.LastHeartbeat = time.Now()
	}
	m.fallbackCache[sessionID] = "hybrid:" + origParams.Encoder
	m.fallbackCacheTime[sessionID] = time.Now()
	m.mu.Unlock()

	startedAt := time.Now()
	go func() {
		err := cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
		elapsed := time.Since(startedAt)
		if err != nil {
			if m.isSessionStopped(sessionID) {
				log.Printf("[HLS] Hybrid fallback stopped (session cleaned up): session=%s", sessionID)
			} else if elapsed < 5*time.Second {
				log.Printf("[HLS] Hybrid also failed fast (%v), trying full SW: session=%s", elapsed, sessionID)
				m.retryWithSoftware(sessionID, inputPath, outputDir, startTime, quality, codec, origParams)
			} else {
				log.Printf("[HLS] Hybrid fallback failed: session=%s err=%v elapsed=%v", sessionID, err, elapsed)
				logFFmpegTail(outputDir, sessionID)
			}
		} else {
			log.Printf("[HLS] Hybrid fallback completed: session=%s encoder=%s", sessionID, hybridParams.Encoder)
			m.mu.Lock()
			if s, ok := m.sessions[sessionID]; ok {
				s.FFmpegDone = true
			}
			m.mu.Unlock()
		}
	}()
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

	resetOutputDir(outputDir)

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

	// Update the session in-place and register in fallback cache
	m.mu.Lock()
	if s, ok := m.sessions[sessionID]; ok {
		s.Cmd = cmd
		s.Cancel = cancel
		s.LastHeartbeat = time.Now() // Refresh heartbeat so SW fallback gets a full 45s window
	}
	// Remember that this session needed full SW fallback, so if it gets recreated
	// (e.g. after heartbeat timeout), we skip VAAPI and hybrid, going straight to SW.
	m.fallbackCache[sessionID] = "sw:" + fallback
	m.fallbackCacheTime[sessionID] = time.Now()
	m.mu.Unlock()

	go func() {
		err := cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
		if err != nil {
			if m.isSessionStopped(sessionID) {
				log.Printf("[HLS] Software fallback stopped (session cleaned up): session=%s", sessionID)
			} else {
				log.Printf("[HLS] Software fallback also failed: session=%s err=%v", sessionID, err)
				logFFmpegTail(outputDir, sessionID)
			}
		} else {
			log.Printf("[HLS] Software fallback completed: session=%s encoder=%s", sessionID, fallback)
			m.mu.Lock()
			if s, ok := m.sessions[sessionID]; ok {
				s.FFmpegDone = true
			}
			m.mu.Unlock()
		}
	}()
}

func (m *HLSManager) GetSessionDir(sessionID string) string {
	return filepath.Join(m.baseDir, sessionID)
}

// SessionInfo is a snapshot of an active HLS session for API responses.
type SessionInfo struct {
	ID            string    `json:"id"`
	InputPath     string    `json:"input_path"`
	Quality       string    `json:"quality"`
	Codec         string    `json:"codec"`
	CreatedAt     time.Time `json:"created_at"`
	LastHeartbeat time.Time `json:"last_heartbeat"`
	Paused        bool      `json:"paused"`
}

// ListSessions returns a snapshot of all active sessions.
func (m *HLSManager) ListSessions() []SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	sessions := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, SessionInfo{
			ID:            s.ID,
			InputPath:     s.InputPath,
			Quality:       s.Quality,
			Codec:         s.Codec,
			CreatedAt:     s.CreatedAt,
			LastHeartbeat: s.LastHeartbeat,
			Paused:        s.Paused,
		})
	}
	return sessions
}

// PauseSession sends SIGSTOP to the FFmpeg process, freezing it immediately.
// This releases GPU resources without killing the process.
func (m *HLSManager) PauseSession(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[sessionID]
	if !ok || s.Paused || s.Stopped {
		return false
	}

	if s.Cmd != nil && s.Cmd.Process != nil {
		if err := s.Cmd.Process.Signal(syscall.SIGSTOP); err != nil {
			log.Printf("[HLS] Failed to SIGSTOP session %s: %v", sessionID, err)
			return false
		}
		s.Paused = true
		s.PausedAt = time.Now()
		log.Printf("[HLS] Paused (SIGSTOP) session: %s", sessionID)
		return true
	}
	return false
}

// ResumeSession sends SIGCONT to a frozen FFmpeg process, resuming transcoding.
func (m *HLSManager) ResumeSession(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[sessionID]
	if !ok || !s.Paused || s.Stopped {
		return false
	}

	if s.Cmd != nil && s.Cmd.Process != nil {
		if err := s.Cmd.Process.Signal(syscall.SIGCONT); err != nil {
			log.Printf("[HLS] Failed to SIGCONT session %s: %v", sessionID, err)
			return false
		}
		s.Paused = false
		s.LastHeartbeat = time.Now() // refresh heartbeat on resume
		log.Printf("[HLS] Resumed (SIGCONT) session: %s", sessionID)
		return true
	}
	return false
}

func (m *HLSManager) StopSession(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if s, ok := m.sessions[sessionID]; ok {
		s.Stopped = true
		// If paused (SIGSTOP), must SIGCONT first so the process can receive the kill signal
		if s.Paused && s.Cmd != nil && s.Cmd.Process != nil {
			s.Cmd.Process.Signal(syscall.SIGCONT)
		}
		s.Cancel()
		os.RemoveAll(s.OutputDir)
		delete(m.sessions, sessionID)
		// Clean fallback cache on explicit stop (user switched quality/seek/navigation)
		delete(m.fallbackCache, sessionID)
		delete(m.fallbackCacheTime, sessionID)
		log.Printf("[HLS] Stopped session: %s", sessionID)
	}
}

// StopSessionsForPath stops all sessions for a given video file, quality, and codec
// except the one with the given excludeID. Used when seeking to a new position.
func (m *HLSManager) StopSessionsForPath(inputPath, quality, codec, excludeID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, s := range m.sessions {
		if id != excludeID && s.InputPath == inputPath && s.Quality == quality && s.Codec == codec {
			s.Stopped = true
			// SIGCONT first if paused so kill signal can be delivered
			if s.Paused && s.Cmd != nil && s.Cmd.Process != nil {
				s.Cmd.Process.Signal(syscall.SIGCONT)
			}
			s.Cancel()
			os.RemoveAll(s.OutputDir)
			delete(m.sessions, id)
			// Clean fallback cache on explicit stop (seek to new position)
			delete(m.fallbackCache, id)
			delete(m.fallbackCacheTime, id)
			log.Printf("[HLS] Stopped old session: %s (replaced by seek)", id)
		}
	}
}

// Heartbeat updates the last heartbeat time for a session.
// Returns true if the session exists, false otherwise.
func (m *HLSManager) Heartbeat(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	if s, ok := m.sessions[sessionID]; ok {
		s.LastHeartbeat = time.Now()
		return true
	}
	return false
}

func (m *HLSManager) cleanup() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		m.mu.Lock()
		now := time.Now()
		for id, s := range m.sessions {
			// Hard limit: 30 minutes max (applies to all sessions)
			if now.Sub(s.CreatedAt) > 30*time.Minute {
				s.Stopped = true
				if s.Paused && s.Cmd != nil && s.Cmd.Process != nil {
					s.Cmd.Process.Signal(syscall.SIGCONT)
				}
				s.Cancel()
				os.RemoveAll(s.OutputDir)
				delete(m.sessions, id)
				log.Printf("[HLS] Stopped session: %s (max age 30m)", id)
				continue
			}
			// Paused sessions: keep alive as long as client sends heartbeats (60s interval).
			// Default 5-minute timeout if no heartbeats received.
			if s.Paused {
				pausedDur := now.Sub(s.PausedAt)
				heartbeatAge := now.Sub(s.LastHeartbeat)
				// Kill if no heartbeat for 2 minutes (client sends every 60s)
				// OR if paused for 5+ minutes without any heartbeat refresh
				if heartbeatAge > 2*time.Minute || (pausedDur > 5*time.Minute && heartbeatAge > 90*time.Second) {
					s.Stopped = true
					if s.Cmd != nil && s.Cmd.Process != nil {
						s.Cmd.Process.Signal(syscall.SIGCONT)
					}
					s.Cancel()
					os.RemoveAll(s.OutputDir)
					delete(m.sessions, id)
					log.Printf("[HLS] Stopped paused session: %s (paused %.0fs, last heartbeat %.0fs ago)", id, pausedDur.Seconds(), heartbeatAge.Seconds())
				}
				continue // skip active heartbeat check for paused sessions
			}
			// Active sessions: idle timeout depends on FFmpeg state.
			// If FFmpeg already finished (all segments written), use 5-minute timeout
			// so viewers can watch the remaining buffered content.
			// If FFmpeg is still running, use 45s timeout.
			activeTimeout := 45 * time.Second
			if s.FFmpegDone {
				activeTimeout = 5 * time.Minute
			}
			if now.Sub(s.LastHeartbeat) > activeTimeout {
				s.Stopped = true
				s.Cancel()
				os.RemoveAll(s.OutputDir)
				delete(m.sessions, id)
				log.Printf("[HLS] Stopped session: %s (heartbeat timeout %.0fs)", id, activeTimeout.Seconds())
			}
		}
		// Purge stale fallback cache entries (30-minute TTL to prevent memory leaks)
		for id, t := range m.fallbackCacheTime {
			if now.Sub(t) > 30*time.Minute {
				delete(m.fallbackCache, id)
				delete(m.fallbackCacheTime, id)
			}
		}
		m.mu.Unlock()
	}
}
