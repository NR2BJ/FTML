package ffmpeg

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// 입력 탐색이 도달한 키프레임을 파일 기준 시각으로 환산한다.
// 시작 지점을 모르면 각 스트림을 따로 0으로 맞추지 않고 변환 후보로 넘긴다.
func copyTimelineOrigin(path string, start float64) (float64, error) {
	info, err := Probe(path)
	if err != nil {
		return 0, err
	}
	formatStart, _ := strconv.ParseFloat(info.StartTime, 64)
	if math.IsNaN(formatStart) || math.IsInf(formatStart, 0) {
		formatStart = 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-read_intervals", fmt.Sprintf("%.3f%%+#512", start+formatStart),
		"-select_streams", "V:0", "-show_entries", "packet=pts_time,flags", "-of", "json", path).Output()
	if err != nil {
		return 0, fmt.Errorf("영상 시작 시각을 확인하지 못했습니다: %w", err)
	}
	var result struct {
		Packets []struct {
			PTS   string `json:"pts_time"`
			Flags string `json:"flags"`
		} `json:"packets"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return 0, err
	}
	for _, p := range result.Packets {
		if !strings.Contains(p.Flags, "K") {
			continue
		}
		pts, err := strconv.ParseFloat(p.PTS, 64)
		if err == nil && !math.IsNaN(pts) && !math.IsInf(pts, 0) {
			if pts-formatStart > start+0.1 {
				return 0, fmt.Errorf("원본 복사 탐색이 요청 시각을 지나쳤습니다")
			}
			return pts - formatStart, nil
		}
	}
	return 0, fmt.Errorf("탐색 지점의 키프레임 시각을 확인하지 못했습니다")
}
