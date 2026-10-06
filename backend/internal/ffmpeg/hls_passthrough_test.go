package ffmpeg

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestPassthroughLeadingFrameFilter(t *testing.T) {
	for _, codec := range []string{"hevc", "h264", "av1"} {
		args := buildFFmpegArgs("input.mkv", t.TempDir(), 6.123, &TranscodeParams{
			Encoder: "copy", SourceVideoCodec: codec, SourceAudioCodec: "aac", SegmentFmt: "fmp4",
		})
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "noise=amount=0:drop='not(eq(pts,nopts))*lt(pts,startpts)'") != (codec == "hevc") {
			t.Fatalf("unexpected packet filter for %s: %v", codec, args)
		}
		if strings.Contains(joined, "independent_segments") {
			t.Fatal("copied GOPs must not promise independently decodable segments")
		}
		if !strings.Contains(joined, "-ss 6.123") || !strings.Contains(joined, "-c:a copy") {
			t.Fatal("seek precision or AAC passthrough changed")
		}
	}
}

// 실제 열린 GOP를 만든 뒤 패킷 해시로 시작 RASL만 제외되는지 확인한다.
// 뒤쪽 GOP의 RASL까지 버리는 filter_units 방식으로 바꾸면 이 시험이 실패한다.
func TestHEVCOpenGOPPassthrough(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s unavailable", tool)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	encoders, err := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-encoders").CombinedOutput()
	if err != nil {
		t.Fatalf("encoder probe failed: %v\n%s", err, encoders)
	}
	if !strings.Contains(string(encoders), "libx265") {
		t.Skip("libx265 unavailable")
	}
	run := func(t *testing.T, tool string, args ...string) []byte {
		t.Helper()
		out, err := exec.CommandContext(ctx, tool, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s failed: %v\n%s", tool, err, out)
		}
		return out
	}
	dir := t.TempDir()
	input := filepath.Join(dir, "open-gop.mkv")
	run(t, "ffmpeg", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=128x96:rate=24",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
		"-t", "14", "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
		"-x265-params", "pools=1:frame-threads=1:keyint=48:min-keyint=48:scenecut=0:open-gop=1:bframes=4:log-level=error",
		"-c:a", "flac", input)

	type packet struct {
		PTS  string `json:"pts_time"`
		Hash string `json:"data_hash"`
	}
	probe := func(t *testing.T, playlist string) []packet {
		t.Helper()
		out := run(t, "ffprobe", "-v", "error", "-allowed_extensions", "ALL", "-i", playlist,
			"-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,data_hash",
			"-show_data_hash", "sha256", "-of", "json")
		var data struct{ Packets []packet }
		if err := json.Unmarshal(out, &data); err != nil || len(data.Packets) == 0 {
			t.Fatalf("invalid packet probe: %v\n%s", err, out)
		}
		for _, p := range data.Packets {
			if !strings.HasPrefix(p.Hash, "SHA256:") {
				t.Fatalf("missing packet hash: %v", p)
			}
		}
		return data.Packets
	}
	pts := func(t *testing.T, p packet) float64 {
		t.Helper()
		v, err := strconv.ParseFloat(p.PTS, 64)
		if err != nil {
			t.Fatalf("invalid packet PTS: %v", p)
		}
		return v
	}
	for _, start := range []float64{0, 6.123} {
		t.Run(strconv.FormatFloat(start, 'f', 3, 64), func(t *testing.T) {
			var baseline, filtered []packet
			for _, legacy := range []bool{true, false} {
				output := filepath.Join(dir, t.Name(), strconv.FormatBool(legacy))
				if err := os.MkdirAll(output, 0755); err != nil {
					t.Fatal(err)
				}
				args := buildFFmpegArgs(input, output, start, &TranscodeParams{
					Encoder: "copy", SourceVideoCodec: "hevc", SourceAudioCodec: "flac", SegmentFmt: "fmp4",
				})
				if legacy {
					for i := range args {
						if args[i] == "-bsf:v" {
							args[i+1] = "setts=pts=PTS-STARTPTS:dts=DTS-STARTPTS"
						}
					}
				}
				run(t, "ffmpeg", args...)
				playlist := filepath.Join(output, "playlist.m3u8")
				if legacy {
					baseline = probe(t, playlist)
				} else {
					filtered = probe(t, playlist)
					run(t, "ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode",
						"-allowed_extensions", "ALL", "-i", playlist, "-map", "0:v:0", "-f", "null", "-")
				}
			}
			first := pts(t, baseline[0])
			var want, got []string
			for _, p := range baseline {
				if pts(t, p) >= first {
					want = append(want, p.Hash)
				}
			}
			for _, p := range filtered {
				got = append(got, p.Hash)
			}
			if start > 0 && len(want) == len(baseline) {
				t.Fatal("fixture did not reproduce leading frames after seek")
			}
			if start == 0 && len(want) != len(baseline) {
				t.Fatal("initial IDR must not lose frames")
			}
			if !reflect.DeepEqual(want, got) {
				t.Fatalf("packet content/order changed: want %d packets, got %d", len(want), len(got))
			}
		})
	}
}
