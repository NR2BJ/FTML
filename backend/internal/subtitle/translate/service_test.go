package translate

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/job"
)

func TestServiceSavesASSWithoutChangingSourceOrTimeline(t *testing.T) {
	media, output := t.TempDir(), t.TempDir()
	database, err := db.NewSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.SetSetting("gemini_api_key", "fake-test-key"); err != nil {
		t.Fatal(err)
	}
	source := "[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,{\\pos(123,45)}Original\n"
	os.WriteFile(filepath.Join(media, "video.mkv"), nil, 0600)
	os.WriteFile(filepath.Join(media, "video.ass"), []byte(source), 0600)
	originalTransport := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport })
	http.DefaultTransport = fakeTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "generativelanguage.googleapis.com" {
			t.Fatalf("예상하지 않은 네트워크 요청: %s", r.URL.Host)
		}
		var request struct {
			Contents []struct{ Parts []struct{ Text string } }
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(request.Contents[0].Parts[0].Text, `\pos`) {
			t.Fatal("효과 명령을 번역기에 전달함")
		}
		return responseJSON(geminiResponse(`[{"id":1,"text":"번역된 간판"}]`, "STOP")), nil
	})
	s := NewService(media, output, database, func() string { return "test-model" })
	params, _ := json.Marshal(job.TranslateParams{SubtitleID: "external:video.ass", TargetLang: "ko", Engine: "gemini"})
	j := &job.Job{FilePath: "video.mkv", Params: params}
	if err := s.HandleJob(context.Background(), j, func(float64) {}); err != nil {
		t.Fatal(err)
	}
	var result job.TranslateResult
	if err := json.Unmarshal(j.Result, &result); err != nil {
		t.Fatal(err)
	}
	name := strings.TrimPrefix(result.OutputPath, "generated:")
	if !strings.HasSuffix(name, ".ass") {
		t.Fatal(name)
	}
	translated, err := os.ReadFile(filepath.Join(output, videoHash("video.mkv"), name))
	if err != nil || !strings.Contains(string(translated), `{\pos(123,45)}번역된 간판`) || !strings.Contains(string(translated), "0:00:02.00,0:00:04.00") {
		t.Fatal(string(translated), err)
	}
	original, _ := os.ReadFile(filepath.Join(media, "video.ass"))
	if string(original) != source {
		t.Fatal("원본 변경")
	}
}
