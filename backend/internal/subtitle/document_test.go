package subtitle_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/video-stream/backend/internal/subtitle"
)

func TestDocumentLoadUsesSameFormatsForUploadedAndExternal(t *testing.T) {
	media, generated := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(media, "video.mkv"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(generated, subtitle.VideoKey("video.mkv"))
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"ass", "ssa", "srt", "vtt", "smi", "sami"} {
		for _, root := range []string{media, dir} {
			if err := os.WriteFile(filepath.Join(root, "sample."+format), []byte(sampleASS), 0600); err != nil {
				t.Fatal(err)
			}
		}
		for _, kind := range []string{"generated", "external"} {
			doc, err := subtitle.Load(context.Background(), media, generated, "video.mkv", kind+":sample."+format)
			if err != nil || doc.Format != format || string(doc.Data) != sampleASS {
				t.Fatalf("%s/%s: %v", kind, format, err)
			}
		}
	}
	for _, id := range []string{"generated:../sample.ass", "external:/etc/passwd", "generated:sample.txt", "embedded:-1", "embedded:1bad", "invalid:sample.ass"} {
		if _, err := subtitle.Load(context.Background(), media, generated, "video.mkv", id); err == nil {
			t.Fatal("잘못된 경로 허용: " + id)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret.ass")
	os.WriteFile(outside, []byte(sampleASS), 0600)
	os.Symlink(outside, filepath.Join(media, "escape.ass"))
	if _, err := subtitle.Load(context.Background(), media, generated, "video.mkv", "external:escape.ass"); err == nil {
		t.Fatal("심볼릭 링크 경계 이탈")
	}
}

func TestDecodeSubtitleText(t *testing.T) {
	for _, data := range [][]byte{{0xff, 0xfe, 'A', 0}, {0xfe, 0xff, 0, 'A'}, {0xef, 0xbb, 0xbf, 'A'}} {
		got, err := subtitle.DecodeText(data)
		if err != nil || string(got) != "A" {
			t.Fatal(got, err)
		}
	}
	if _, err := subtitle.DecodeText([]byte{0xff, 0xfe, 0}); err == nil {
		t.Fatal("손상된 UTF-16 허용")
	}
}

func TestASSTranslationKeepsPositionAndDoesNotExecuteTranslatedTags(t *testing.T) {
	data := strings.Replace(sampleASS, "Ordinary, dialogue", `{\pos(123,45)\frz15\fad(100,200)}Sign`, 1)
	plan := subtitle.PrepareASSTranslation([]byte(data))
	if len(plan.Texts) != 2 {
		t.Fatalf("효과를 번역 대상으로 잘못 포함: %+v", plan.Texts)
	}
	texts := map[int]string{}
	for _, cue := range plan.Texts {
		texts[cue.ID] = "번역 {\\pos(1,2)}\n두 번째 줄"
	}
	out, err := plan.Render(texts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `{\pos(123,45)\frz15\fad(100,200)}번역`) {
		t.Fatal("원래 위치/회전/페이드 소실")
	}
	if strings.Contains(string(out), `{\pos(1,2)}`) {
		t.Fatal("번역 결과가 효과를 삽입함")
	}
	if !strings.Contains(string(out), `\N두 번째 줄`) {
		t.Fatal("줄바꿈 손실")
	}
	if plan.Fallbacks != 1 || !strings.Contains(string(out), `fx,{\pos(20,10)}B`) {
		t.Fatal("원문 노래 효과 소실")
	}
	if _, err := plan.Render(map[int]string{}); err == nil {
		t.Fatal("번역 누락 허용")
	}
	if len(plan.Texts) > 0 && (plan.Texts[0].Start != 1 || plan.Texts[0].End != 4) {
		t.Fatal("시간이 변경됨")
	}
}

func TestDocumentPlainConversion(t *testing.T) {
	for format, input := range map[string]string{
		"srt": "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
		"smi": "<SAMI><BODY><SYNC Start=1000><P>Hello<SYNC Start=2000><P>&nbsp;</BODY></SAMI>",
		"ass": sampleASS,
	} {
		out, err := (subtitle.Document{Format: format, Data: []byte(input)}).VTT(context.Background())
		if err != nil || !strings.HasPrefix(string(out), "WEBVTT") {
			t.Fatalf("%s: %s %v", format, out, err)
		}
	}
}
