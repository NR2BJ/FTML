package subtitle

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/storage"
)

const MaxDocumentBytes = 16 << 20

type Document struct {
	Data   []byte
	Format string
}

func VideoKey(path string) string {
	h := sha256.Sum256([]byte(path))
	return fmt.Sprintf("%x", h[:8])
}

func IsASS(format string) bool { return format == "ass" || format == "ssa" }

func ResolveFile(base, name string) (string, error) {
	path, err := storage.ResolveWithinBase(base, name)
	if err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	actual, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, actual)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", os.ErrPermission
	}
	return actual, nil
}

// Load는 표시와 번역에서 동일한 형식/경로 검증을 사용한다.
func Load(ctx context.Context, mediaRoot, subtitleRoot, video, id string) (Document, error) {
	videoPath, err := ResolveFile(mediaRoot, video)
	if err != nil {
		return Document{}, err
	}
	kind, name, ok := strings.Cut(id, ":")
	if !ok {
		return Document{}, fmt.Errorf("잘못된 자막 식별자")
	}
	if kind == "embedded" {
		index, err := strconv.Atoi(name)
		if err != nil || index < 0 {
			return Document{}, fmt.Errorf("잘못된 자막 스트림")
		}
		info, err := ffmpeg.Probe(videoPath)
		if err != nil {
			return Document{}, err
		}
		format := ""
		for _, stream := range info.Streams {
			if stream.Index == index && stream.CodecType == "subtitle" {
				format = "webvtt"
				if IsASS(stream.CodecName) {
					format = "ass"
				}
			}
		}
		if format == "" {
			return Document{}, fmt.Errorf("자막 스트림이 아닙니다")
		}
		data, err := runFFmpeg(ctx, nil, "-i", videoPath, "-map", fmt.Sprintf("0:%d", index), "-f", format, "pipe:1")
		return Document{Data: data, Format: format}, err
	}
	if name == "" || filepath.Base(name) != name || strings.ContainsAny(name, `/\`) || !storage.IsSubtitleFile(name) {
		return Document{}, fmt.Errorf("지원하지 않는 자막 파일")
	}
	base := filepath.Dir(videoPath)
	if kind == "generated" {
		base = filepath.Join(subtitleRoot, VideoKey(video))
	} else if kind != "external" {
		return Document{}, fmt.Errorf("잘못된 자막 종류")
	}
	path, err := ResolveFile(base, name)
	if err != nil {
		return Document{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return Document{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxDocumentBytes+1))
	if err != nil {
		return Document{}, err
	}
	if len(data) > MaxDocumentBytes {
		return Document{}, fmt.Errorf("자막 크기 제한 초과")
	}
	data, err = DecodeText(data)
	return Document{Data: data, Format: strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")}, err
}

func DecodeText(data []byte) ([]byte, error) {
	if len(data) >= 2 && (bytes.HasPrefix(data, []byte{0xff, 0xfe}) || bytes.HasPrefix(data, []byte{0xfe, 0xff})) {
		var order binary.ByteOrder = binary.BigEndian
		if data[0] == 0xff {
			order = binary.LittleEndian
		}
		if len(data)%2 != 0 {
			return nil, fmt.Errorf("손상된 UTF-16 자막")
		}
		words := make([]uint16, (len(data)-2)/2)
		for i := range words {
			words[i] = order.Uint16(data[2+i*2:])
		}
		data = []byte(string(utf16.Decode(words)))
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("자막을 UTF-8 또는 UTF-16으로 저장해 주세요")
	}
	return data, nil
}

func (d Document) VTT(ctx context.Context) ([]byte, error) {
	return d.Convert(ctx, "vtt")
}

func (d Document) Convert(ctx context.Context, target string) ([]byte, error) {
	if target == "vtt" {
		target = "webvtt"
	}
	if target != "webvtt" && target != "srt" && target != "ass" {
		return nil, fmt.Errorf("지원하지 않는 출력 형식")
	}
	format := d.Format
	if format == "vtt" {
		format = "webvtt"
	}
	if format == target {
		return d.Data, nil
	}
	data := d.Data
	if IsASS(d.Format) && target != "ass" {
		data = NormalizeASSForText(data)
	}
	if format == "ssa" {
		format = "ass"
	}
	if format == "smi" {
		format = "sami"
	}
	if format != "ass" && format != "srt" && format != "sami" && format != "webvtt" {
		return nil, fmt.Errorf("지원하지 않는 자막 형식")
	}
	return runFFmpeg(ctx, data, "-f", format, "-i", "pipe:0", "-f", target, "pipe:1")
}

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > MaxDocumentBytes {
		return 0, fmt.Errorf("자막 출력 크기 제한 초과")
	}
	return b.Buffer.Write(p)
}

func runFFmpeg(ctx context.Context, input []byte, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", append([]string{"-nostdin", "-hide_banner", "-loglevel", "error"}, args...)...)
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	var output limitedBuffer
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("자막 변환 실패: %w", err)
	}
	return output.Bytes(), nil
}
