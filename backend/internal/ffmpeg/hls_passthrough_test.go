package ffmpeg

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
		if strings.Contains(joined, "hevc_mp4toannexb,noise=") != (codec == "hevc") {
			t.Fatalf("unexpected HEVC initialization normalization for %s: %v", codec, args)
		}
		if strings.Contains(joined, "independent_segments") {
			t.Fatal("copied GOPs must not promise independently decodable segments")
		}
		if !strings.Contains(joined, "-ss 6.123") || !strings.Contains(joined, "-c:a copy") {
			t.Fatal("seek precision or AAC passthrough changed")
		}
	}
}

// 실제 열린 GOP를 만든 뒤 영상 NAL 해시로 시작 RASL만 제외되는지 확인한다.
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
		PTS     string `json:"pts_time"`
		Data    string `json:"data"`
		VCLHash string
	}
	probe := func(t *testing.T, playlist string) []packet {
		t.Helper()
		out := run(t, "ffprobe", "-v", "error", "-allowed_extensions", "ALL", "-i", playlist,
			"-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,data",
			"-show_data", "-of", "json")
		var data struct{ Packets []packet }
		if err := json.Unmarshal(out, &data); err != nil || len(data.Packets) == 0 {
			t.Fatalf("invalid packet probe: %v\n%s", err, out)
		}
		for i := range data.Packets {
			// Annex B 왕복으로 VPS/SPS/PPS가 추가될 수 있으므로 압축 영상 VCL을 비교한다.
			payload := decodeProbeHex(t, data.Packets[i].Data)
			var vcl []byte
			for len(payload) > 0 {
				if len(payload) < 6 {
					t.Fatal("truncated NAL packet")
				}
				size := int(binary.BigEndian.Uint32(payload[:4]))
				if size < 2 || size > len(payload)-4 {
					t.Fatal("invalid NAL length")
				}
				if (payload[4]>>1)&0x3f < 32 {
					vcl = append(vcl, payload[:4+size]...)
				}
				payload = payload[4+size:]
			}
			if len(vcl) == 0 {
				t.Fatal("fixture packet must contain coded video")
			}
			data.Packets[i].VCLHash = fmt.Sprintf("%x", sha256.Sum256(vcl))
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
					want = append(want, p.VCLHash)
				}
			}
			for _, p := range filtered {
				got = append(got, p.VCLHash)
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

	t.Run("legacy_hvcc", func(t *testing.T) {
		// 사용자 영상 대신 생성한 MKV의 CodecPrivate 버전만 0으로 바꿔 재현한다.
		out := run(t, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
			"stream=extradata", "-show_data", "-of", "json", input)
		var data struct {
			Streams []struct{ Extradata string }
		}
		if err := json.Unmarshal(out, &data); err != nil || len(data.Streams) != 1 {
			t.Fatalf("invalid extradata probe: %v\n%s", err, out)
		}
		private := decodeProbeHex(t, data.Streams[0].Extradata)
		if len(private) < 23 || private[0] != 1 {
			t.Fatal("fixture must start with a standard hvcC record")
		}
		mkv, err := os.ReadFile(input)
		if err != nil {
			t.Fatal(err)
		}
		pos := bytes.Index(mkv, private)
		if pos < 0 || bytes.Count(mkv, private) != 1 {
			t.Fatal("fixture CodecPrivate must occur exactly once")
		}
		mkv[pos] = 0
		legacyInput := filepath.Join(dir, "legacy.mkv")
		if err := os.WriteFile(legacyInput, mkv, 0600); err != nil {
			t.Fatal(err)
		}
		// 원래 입력과 구형 초기화 정보의 입력이 동일한 영상 패킷을 내보내야 한다.
		for _, start := range []float64{0, 6.123} {
			output := filepath.Join(dir, "legacy-output", strconv.FormatFloat(start, 'f', 3, 64))
			if err := os.MkdirAll(output, 0755); err != nil {
				t.Fatal(err)
			}
			run(t, "ffmpeg", buildFFmpegArgs(legacyInput, output, start, &TranscodeParams{
				Encoder: "copy", SourceVideoCodec: "hevc", SourceAudioCodec: "flac", SegmentFmt: "fmp4",
			})...)
			init, err := os.ReadFile(filepath.Join(output, "init.mp4"))
			if err != nil {
				t.Fatal(err)
			}
			hvcc := bytes.Index(init, []byte("hvcC"))
			if hvcc < 0 || hvcc+4 >= len(init) || init[hvcc+4] != 1 {
				t.Fatal("output must contain a version 1 hvcC record")
			}
			playlist := filepath.Join(output, "playlist.m3u8")
			got := probe(t, playlist)
			standardOutput := output + "-standard"
			if err := os.MkdirAll(standardOutput, 0755); err != nil {
				t.Fatal(err)
			}
			run(t, "ffmpeg", buildFFmpegArgs(input, standardOutput, start, &TranscodeParams{
				Encoder: "copy", SourceVideoCodec: "hevc", SourceAudioCodec: "flac", SegmentFmt: "fmp4",
			})...)
			want := probe(t, filepath.Join(standardOutput, "playlist.m3u8"))
			if !reflect.DeepEqual(want, got) {
				t.Fatal("legacy hvcC normalization changed video packets or timestamps")
			}
			run(t, "ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode",
				"-allowed_extensions", "ALL", "-i", playlist, "-map", "0:v:0", "-f", "null", "-")
		}
	})
}

func decodeProbeHex(t *testing.T, dump string) []byte {
	t.Helper()
	var result []byte
	for _, line := range strings.Split(dump, "\n") {
		_, row, ok := strings.Cut(line, ": ")
		if !ok {
			continue
		}
		hexPart, _, _ := strings.Cut(row, "  ")
		decoded, err := hex.DecodeString(strings.ReplaceAll(hexPart, " ", ""))
		if err != nil {
			t.Fatal(err)
		}
		result = append(result, decoded...)
	}
	return result
}
