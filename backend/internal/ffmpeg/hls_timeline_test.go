package ffmpeg

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 5.1초의 짧은 소리가 탐색/음성 변환 후에도 5.1초에 남는지 확인한다.
// 개별 STARTPTS 초기화는 영상과 음성의 서로 다른 앞부분을 지우므로 실패한다.
func TestHLSCommonTimeline(t *testing.T) {
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skip(name + " unavailable")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	run := func(name string, args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, name, args...)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return out
	}
	dir := t.TempDir()
	for _, audio := range []string{"flac", "aac"} {
		input := filepath.Join(dir, audio+".mkv")
		run("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x96:r=24",
			"-f", "lavfi", "-i", "aevalsrc=if(between(t\\,5.1\\,5.15)\\,0.6*sin(2*PI*1000*t)\\,0):s=48000",
			"-t", "9", "-c:v", "libx264", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-c:a", audio, input)
		for _, mode := range []string{"copy", "libx264"} {
			t.Run(audio+"/"+mode, func(t *testing.T) {
				output := t.TempDir()
				params := &TranscodeParams{Encoder: mode, VideoCodec: "h264", SourceVideoCodec: "h264", SourceAudioCodec: audio, SegmentFmt: "fmp4", Height: 96, CRF: 23, MaxBitrate: "1M", BufSize: "2M"}
				args := buildFFmpegArgs(input, output, 3.123, params)
				if strings.Contains(strings.Join(args, " "), "STARTPTS") {
					t.Fatal("stream-local clock reset")
				}
				run("ffmpeg", args...)
				playlist := filepath.Join(output, "playlist.m3u8")
				var result struct {
					Frames []struct {
						PTS string `json:"pts_time"`
					} `json:"frames"`
				}
				json.Unmarshal(run("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_frames", "-show_entries", "frame=pts_time", "-of", "json", playlist), &result)
				if len(result.Frames) == 0 {
					t.Fatal("no decoded audio")
				}
				first, err := strconv.ParseFloat(result.Frames[0].PTS, 64)
				if err != nil {
					t.Fatal(err)
				}
				pcm := run("ffmpeg", "-v", "error", "-i", playlist, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1")
				peak := -1
				for i := 0; i+1 < len(pcm); i += 2 {
					if math.Abs(float64(int16(binary.LittleEndian.Uint16(pcm[i:])))) > 8000 {
						peak = i / 2
						break
					}
				}
				at := first + float64(peak)/48000
				// AAC 입력의 인코더 지연/컨테이너 반올림까지 40ms 안에서 허용한다.
				if peak < 0 || math.Abs(at-5.1) > 0.04 {
					t.Fatalf("sound moved: %.6f (first %.6f)", at, first)
				}
				data, _ := os.ReadFile(playlist)
				if !strings.Contains(string(data), "#EXT-X-ENDLIST") {
					t.Fatal("incomplete playlist")
				}
			})
		}
	}
}
