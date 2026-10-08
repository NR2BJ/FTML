package ffmpeg

import (
	"bufio"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// 재생 소유자에게만 반환한다. 파일 경로와 FFmpeg 원문 오류는 포함하지 않는다.
type PlaybackStatus struct {
	ID           string  `json:"id"`
	State        string  `json:"state"`
	Codec        string  `json:"codec"`
	Encoder      string  `json:"encoder"`
	Acceleration string  `json:"acceleration"`
	OutputTime   float64 `json:"output_time"`
	Speed        float64 `json:"speed"`
	Paused       bool    `json:"paused"`
	Throttled    bool    `json:"throttled"`
}

func acceleration(p *TranscodeParams) string {
	if p.Encoder == "copy" {
		return "copy"
	}
	if p.HWAccel == "vaapi" {
		return "hardware"
	}
	if strings.HasSuffix(p.Encoder, "_vaapi") && p.Device != "" {
		return "hybrid"
	}
	return "software"
}

func (m *HLSManager) PlaybackStatus(id string, owner int64) (PlaybackStatus, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[id]
	if !ok || s.Stopped || s.OwnerID != owner {
		return PlaybackStatus{}, false
	}
	state := "running"
	if s.FFmpegDone {
		state = "completed"
	}
	if s.Failure != "" {
		state = "failed"
	}
	return PlaybackStatus{ID: id, State: state, Codec: s.Codec, Encoder: s.Encoder, Acceleration: s.Acceleration, OutputTime: s.OutputTime, Speed: s.Speed, Paused: s.Paused, Throttled: s.Throttled}, true
}

func (m *HLSManager) readProgress(s *HLSSession, r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		key, _, ok := strings.Cut(scanner.Text(), "=")
		if !ok {
			continue
		}
		if key != "progress" {
			continue
		}
		// copyts의 out_time은 FFmpeg 버전에 따라 0이므로 완성된 조각으로 계산한다.
		// 준비 분량에는 키프레임 앞부분만큼의 오차가 있을 수 있다.
		end := s.StartTime
		if data, err := os.ReadFile(filepath.Join(s.OutputDir, "playlist.m3u8")); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "#EXTINF:") {
					length, _, _ := strings.Cut(strings.TrimPrefix(line, "#EXTINF:"), ",")
					if n, err := strconv.ParseFloat(length, 64); err == nil && n > 0 && !math.IsInf(n, 0) {
						end += n
					}
				}
			}
		}
		m.mu.Lock()
		if m.sessions[s.ID] != s || s.Stopped {
			m.mu.Unlock()
			continue
		}
		now := time.Now()
		if !s.ProgressAt.IsZero() && end > s.OutputTime {
			s.Speed = (end - s.OutputTime) / now.Sub(s.ProgressAt).Seconds()
		}
		if end > s.OutputTime || s.ProgressAt.IsZero() {
			s.ProgressAt = now
		}
		s.OutputTime = end
		m.updateThrottle(s)
		m.mu.Unlock()
	}
}

func (m *HLSManager) UpdatePosition(id string, position float64) {
	if position < 0 || math.IsNaN(position) || math.IsInf(position, 0) {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[id]; ok && !s.Stopped {
		s.Position = position
		m.updateThrottle(s)
	}
}

func (m *HLSManager) signalPause(s *HLSSession, pause bool) error {
	if s.Cmd == nil || s.Cmd.Process == nil || s.FFmpegDone {
		return nil
	}
	signal := syscall.SIGCONT
	if pause {
		signal = syscall.SIGSTOP
	}
	return s.Cmd.Process.Signal(signal)
}

func (m *HLSManager) updateThrottle(s *HLSSession) {
	if s.Stopped || s.FFmpegDone || s.Failure != "" {
		return
	}
	// 시작에는 충분한 여유를 확보하고, 오래 앞서 변환하며 디스크를 채우지 않는다.
	want := s.Throttled
	if s.OutputTime-s.Position > 90 {
		want = true
	}
	if s.OutputTime-s.Position < 45 {
		want = false
	}
	if want != s.Throttled && m.signalPause(s, s.Paused || want) == nil {
		s.Throttled = want
	}
	if want {
		s.ProgressAt = time.Time{}
	}
}

// 호출자는 잠금을 보유한다. 종료 완료 뒤 파일을 정리하여 늦게 쓰는 프로세스와 경합하지 않는다.
func (m *HLSManager) stopLocked(s *HLSSession) {
	s.Stopped = true
	if s.Cancel != nil {
		s.Cancel()
	}
	delete(m.sessions, s.ID)
	if m.retired == nil {
		m.retired = make(map[string]time.Time)
	}
	m.retired[s.ID] = time.Now()
	if s.ProcessDone == nil {
		os.RemoveAll(s.OutputDir)
		return
	}
	go func() { <-s.ProcessDone; os.RemoveAll(s.OutputDir) }()
}
