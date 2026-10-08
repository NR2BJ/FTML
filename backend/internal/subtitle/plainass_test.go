package subtitle_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/video-stream/backend/internal/subtitle"
	"github.com/video-stream/backend/internal/subtitle/translate"
)

const sampleASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Song,Arial,30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:01.00,0:00:04.00,Song,,0,0,0,karaoke,{\k100}A{\k200}B
Comment: 0,0:00:01.00,0:00:04.00,Song,,0,0,0,,not displayed
Dialogue: 0,0:00:00.50,0:00:01.00,Song,,0,0,0,fx,{\move(0,0,10,10)}A
Dialogue: 0,0:00:00.50,0:00:01.00,Song,,0,0,0,fx,{\move(0,0,20,10)}B
Dialogue: 2,0:00:01.00,0:00:02.00,Song,,0,0,0,fx,{\pos(10,10)}A
Dialogue: 2,0:00:02.00,0:00:04.00,Song,,0,0,0,fx,{\pos(10,10)}A
Dialogue: 2,0:00:01.00,0:00:04.00,Song,,0,0,0,fx,{\pos(20,10)}B
Dialogue: 0,0:00:01.00,0:00:03.00,Song,,0,0,0,fx,{\pos(20,10)\1a&HFF&}●
Dialogue: 0,0:00:01.00,0:00:04.00,Song,,0,0,0,,Ordinary, dialogue
Dialogue: 0,0:00:05.00,0:00:06.00,Other,,0,0,0,fx,{\pos(10,10)}Unrelated
`

func TestNormalizeKaraokeKeepsSentencesAndUnrelatedEvents(t *testing.T) {
	input := []byte("\ufeff" + strings.ReplaceAll(sampleASS, "\n", "\r\n"))
	result := string(subtitle.NormalizeASSForText(input))
	if strings.Count(result, "Dialogue:") != 3 || !strings.Contains(result, `,,{\k100}A{\k200}B`) || strings.Contains(result, "}●") {
		t.Fatalf("가사 문장 복원/효과 제거 실패: %s", result)
	}
	if !strings.Contains(result, "Ordinary, dialogue") || !strings.Contains(result, "Unrelated") || !strings.Contains(result, "Comment:") {
		t.Fatal("일반 대사/다른 효과/주석이 보존되지 않음")
	}
	if string(subtitle.NormalizeASSForText([]byte(result))) != result {
		t.Fatal("반복 처리 결과가 달라짐")
	}
}

func TestNormalizeDoesNotGuessMissingOrAmbiguousSources(t *testing.T) {
	for name, source := range map[string]string{
		"no-source":        strings.Replace(sampleASS, ",karaoke,", ",disabled,", 1),
		"incomplete":       strings.Replace(sampleASS, `A{\k200}B`, `A{\k200}BC`, 1),
		"ambiguous":        sampleASS + "Comment: 0,0:00:02.00,0:00:05.00,Song,,0,0,0,karaoke,{\\k100}AB\n",
		"invalid-time":     strings.Replace(sampleASS, "Comment: 0,0:00:01.00", "Comment: 0,-1:00:01.00", 1),
		"duplicate-column": strings.Replace(sampleASS, "MarginV, Effect, Text", "MarginV, Effect, Text, Start", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if string(subtitle.NormalizeASSForText([]byte(source))) != source {
				t.Fatal("확인되지 않은 원문을 추측해 변경함")
			}
		})
	}
}

func TestConvertASSForDisplayTranslationAndExport(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("FFmpeg 필요")
	}
	path := filepath.Join(t.TempDir(), "sample.ass")
	if err := os.WriteFile(path, []byte(sampleASS), 0600); err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"webvtt", "vtt", "srt"} {
		out, err := subtitle.ConvertASSFile(context.Background(), path, format)
		if err != nil {
			t.Fatal(err)
		}
		cues := translate.ParseVTT(string(out))
		if len(cues) != 3 || cues[0].Text != "AB" || cues[0].Start != 1 || cues[0].End != 4 {
			t.Fatalf("%s: 예상과 다른 문장/시간: %+v", format, cues)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := subtitle.ConvertASSFile(ctx, path, "vtt"); err == nil {
		t.Fatal("취소 무시")
	}
	if _, err := subtitle.ConvertASSFile(context.Background(), path, "ass"); err == nil {
		t.Fatal("원본 효과 형식은 변환 대상 아님")
	}
	original, err := os.ReadFile(path)
	if err != nil || string(original) != sampleASS {
		t.Fatal("원본 파일 변경됨")
	}
}

// 사용자 파일은 저장소에 포함하지 않고 필요할 때만 환경 변수로 읽는다.
func TestProvidedASSPlainText(t *testing.T) {
	path := os.Getenv("FTML_ASS_SAMPLE")
	if path == "" {
		t.Skip("실제 사용자 ASS 미지정")
	}
	before, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-f", "webvtt", "pipe:1").Output()
	if err != nil {
		t.Fatal(err)
	}
	beforeCount := 0
	for _, cue := range translate.ParseVTT(string(before)) {
		if cue.Start <= 36 && cue.End > 36 {
			beforeCount++
		}
	}
	out, err := subtitle.ConvertASSFile(context.Background(), path, "vtt")
	if err != nil {
		t.Fatal(err)
	}
	var active []translate.SubtitleCue
	for _, cue := range translate.ParseVTT(string(out)) {
		if cue.Start <= 36 && cue.End > 36 {
			active = append(active, cue)
		}
	}
	if len(active) != 2 {
		t.Fatalf("36초에서 두 문장 대신 %d개 조각이 활성화됨", len(active))
	}
	if beforeCount <= len(active) {
		t.Fatal("원본 변환에서 글자 적층이 재현되지 않음")
	}
	t.Logf("36초의 동시 자막: 기존 %d개 -> 수정 후 %d개", beforeCount, len(active))
	for _, cue := range active {
		if len([]rune(cue.Text)) < 5 {
			t.Fatal("글자 조각이 문장으로 복원되지 않음")
		}
	}
}
