package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestSubtitleHTTPUploadNativePlainExportAndAttachments(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("FFmpeg 필요")
	}
	media, data := t.TempDir(), t.TempDir()
	ass := "[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.10,0:00:00.80,Default,,0,0,0,,{\\pos(30,30)}Hello\n"
	os.WriteFile(filepath.Join(media, "video.ass"), []byte(ass), 0600)
	os.WriteFile(filepath.Join(media, "font.ttf"), []byte("fixture-font"), 0600)
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=32x32:d=1", "-i", filepath.Join(media, "video.ass"), "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-c:s", "ass", "-attach", filepath.Join(media, "font.ttf"), "-metadata:s:t", "mimetype=application/x-truetype-font", "-metadata:s:t", "filename=../font.ttf", filepath.Join(media, "video.mkv"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(string(out), err)
	}
	h := NewSubtitleHandler(media, data, nil, nil)
	r := chi.NewRouter()
	r.Get("/content/*", h.ServeSubtitle)
	r.Get("/list/*", h.ListSubtitles)
	r.Get("/fonts/*", h.SubtitleFonts)
	r.Get("/font/*", h.SubtitleFont)
	r.Post("/upload/*", h.UploadSubtitle)
	r.Post("/export/*", h.ConvertSubtitle)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, _ := mw.CreateFormFile("file", "uploaded.ass")
	part.Write([]byte(ass))
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/upload/video.mkv", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, id := range []string{"external:video.ass", "generated:uploaded.ass", "embedded:1"} {
		for _, mode := range []string{"native", "plain"} {
			w = httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest("GET", "/content/video.mkv?id="+url.QueryEscape(id)+"&mode="+mode, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("%s %s: %d %s", id, mode, w.Code, w.Body.String())
			}
			if mode == "native" && !strings.Contains(w.Body.String(), `\pos(30,30)`) {
				t.Fatal("원형 효과 소실")
			}
			if mode == "plain" && (!strings.HasPrefix(w.Body.String(), "WEBVTT") || strings.Contains(w.Body.String(), `\pos`)) {
				t.Fatal("일반 표시 변환 실패")
			}
		}
		for _, format := range []string{"ass", "vtt", "srt"} {
			w = httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest("POST", "/export/video.mkv", strings.NewReader(fmt.Sprintf(`{"subtitle_id":%q,"target_format":%q}`, id, format))))
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Hello") {
				t.Fatalf("내보내기 %s/%s: %d %s", id, format, w.Code, w.Body.String())
			}
		}
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/list/video.mkv", nil))
	if !strings.Contains(w.Body.String(), "generated:uploaded.ass") {
		t.Fatal("업로드 ASS 목록 누락")
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/fonts/video.mkv", nil))
	var fonts []int
	if err := json.Unmarshal(w.Body.Bytes(), &fonts); err != nil || len(fonts) != 1 {
		t.Fatal(w.Body.String(), err)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", fmt.Sprintf("/font/video.mkv?font=%d", fonts[0]), nil))
	if w.Code != http.StatusOK || w.Body.String() != "fixture-font" {
		t.Fatal("첨부 글꼴 추출", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/font/video.mkv?font=0", nil))
	if w.Code != http.StatusNotFound {
		t.Fatal("영상 스트림을 글꼴로 제공함")
	}
}
