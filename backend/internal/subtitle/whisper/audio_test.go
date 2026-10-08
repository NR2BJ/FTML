package whisper

import (
	"context"
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestAudioExtractionKeepsDelayedTrackAndMono(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("FFmpeg 필요")
	}
	dir := t.TempDir()
	video := filepath.Join(dir, "delayed.mkv")
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=32x32:d=4", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=4", "-itsoffset", "2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-c:a", "pcm_s16le", video)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(string(out), err)
	}
	for track := 0; track <= 1; track++ {
		path, err := extractAudio(context.Background(), video, track)
		if err != nil {
			t.Fatal(err)
		}
		defer os.Remove(path)
		data, err := exec.Command("ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "pipe:1").Output()
		if err != nil {
			t.Fatal(err)
		}
		first, last := -1, -1
		for i := 0; i+1 < len(data); i += 2 {
			value := int16(binary.LittleEndian.Uint16(data[i:]))
			if math.Abs(float64(value)) > 30 {
				if first < 0 {
					first = i / 2
				}
				last = i / 2
			}
		}
		if track == 0 && first != -1 {
			t.Fatal("선택하지 않은 음성 혼입")
		}
		if track == 1 && (math.Abs(float64(first)/16000-2) > .04 || math.Abs(float64(last)/16000-3) > .04) {
			t.Fatalf("음성 시간 이동: 시작 %.3f 끝 %.3f", float64(first)/16000, float64(last)/16000)
		}
	}
}
