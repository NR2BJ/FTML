package handlers

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/subtitle"
)

func isFontAttachment(s ffmpeg.ProbeStream) bool {
	ext := strings.ToLower(filepath.Ext(s.Tags["filename"]))
	return s.CodecType == "attachment" && s.ExtraDataSize > 0 && s.ExtraDataSize <= 24<<20 && (ext == ".ttf" || ext == ".otf" || ext == ".ttc" || ext == ".woff2")
}

func (h *SubtitleHandler) SubtitleFonts(w http.ResponseWriter, r *http.Request) {
	path, pathErr := subtitle.ResolveFile(h.mediaPath, extractPath(r))
	if pathErr != nil {
		jsonError(w, "잘못된 경로", http.StatusForbidden)
		return
	}
	info, err := ffmpeg.Probe(path)
	ids := []int{}
	if err == nil {
		for _, stream := range info.Streams {
			if isFontAttachment(stream) && len(ids) < 32 {
				ids = append(ids, stream.Index)
			}
		}
	}
	jsonResponse(w, ids, http.StatusOK)
}

func (h *SubtitleHandler) SubtitleFont(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("font") == "default" {
		path := os.Getenv("SUBTITLE_FALLBACK_FONT")
		if path == "" {
			path = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
		}
		w.Header().Set("Cache-Control", "private, max-age=86400")
		w.Header().Set("Content-Type", "font/collection")
		http.ServeFile(w, r, path)
		return
	}
	path, pathErr := subtitle.ResolveFile(h.mediaPath, extractPath(r))
	index, err := strconv.Atoi(r.URL.Query().Get("font"))
	if pathErr != nil || err != nil || index < 0 {
		jsonError(w, "잘못된 글꼴 요청", http.StatusBadRequest)
		return
	}
	info, err := ffmpeg.Probe(path)
	valid := false
	if err == nil {
		for _, stream := range info.Streams {
			if stream.Index == index && isFontAttachment(stream) {
				valid = true
			}
		}
	}
	if !valid {
		jsonError(w, "첨부 글꼴이 아닙니다", http.StatusNotFound)
		return
	}
	dir, err := os.MkdirTemp("", "ftml-font-")
	if err != nil {
		jsonError(w, "글꼴 준비 실패", http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(dir)
	// 첨부 파일명은 경로로 사용하지 않는다.
	out := filepath.Join(dir, "font.bin")
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-dump_attachment:"+fmt.Sprint(index), out, "-i", path, "-t", "0", "-f", "null", "-")
	_ = cmd.Run() // 영상 디코더 실패와 첨부 추출 성공을 구분한다.
	stat, err := os.Stat(out)
	if ctx.Err() != nil || err != nil || stat.Size() > 24<<20 || stat.Size() == 0 {
		jsonError(w, "첨부 글꼴 추출 실패", http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, out)
}
