package job

import (
	"encoding/json"
	"testing"
	"time"
)

func TestTranslationSourceLabelDoesNotDuplicateWork(t *testing.T) {
	q, _ := newTestQueue(t)
	p := TranslateParams{SubtitleID: "external:episode.cht.ass", Engine: "gemini", TargetLang: "ko"}
	first, err := q.Enqueue(JobTranslate, "episode.mkv", p)
	if err != nil {
		t.Fatal(err)
	}
	p.SourceLabel = "외부 자막 episode.cht.ass"
	next, err := q.Enqueue(JobTranslate, "episode.mkv", p)
	if err != nil || next.ID != first.ID {
		t.Fatal("표시 이름 변경으로 중복 번역", err)
	}
	p.SubtitleID = "generated:whisper_ja.vtt"
	different, err := q.Enqueue(JobTranslate, "episode.mkv", p)
	if err != nil || different.ID == first.ID {
		t.Fatal("다른 원본 번역을 합침", err)
	}
}

func TestTranslationSourcesOnlyUseLatestCompletedJobForSameVideo(t *testing.T) {
	q, d := newTestQueue(t)
	for i, item := range []struct{ path, source, status string }{
		{"a.mkv", "old", "completed"}, {"a.mkv", "current", "completed"},
		{"a.mkv", "failed", "failed"}, {"b.mkv", "other", "completed"},
	} {
		j, err := q.Enqueue(JobTranslate, item.path, TranslateParams{SubtitleID: item.source, SourceLabel: "label-" + item.source})
		if err != nil {
			t.Fatal(err)
		}
		result, _ := json.Marshal(TranslateResult{OutputPath: "generated:translate_ko_gemini.vtt"})
		if _, err = d.DB().Exec("UPDATE jobs SET status=?, result=?, completed_at=? WHERE id=?", item.status, string(result), time.Now().Add(time.Duration(i)*time.Second), j.ID); err != nil {
			t.Fatal(err)
		}
	}
	sources, err := q.TranslationSources("a.mkv")
	if err != nil || len(sources) != 1 || sources["generated:translate_ko_gemini.vtt"] != (TranslationSource{ID: "current", Label: "label-current"}) {
		t.Fatal(sources, err)
	}
}
