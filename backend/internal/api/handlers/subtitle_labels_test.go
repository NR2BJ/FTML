package handlers

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/video-stream/backend/internal/job"
)

func translatedEntry(source string) SubtitleEntry {
	digest := sha256.Sum256([]byte(source))
	name := fmt.Sprintf("translate_ko_gemini_%x.ass", digest[:8])
	label, lang := generatedSubtitleLabel(name)
	return SubtitleEntry{ID: "generated:" + name, Label: label, Language: lang, Type: "generated", Format: "ass"}
}

func TestExtractionLabelsIncludeEngineLanguageAndTrack(t *testing.T) {
	for _, tt := range []struct{ name, label, lang string }{
		{"whisper_ja.vtt", "Whisper 추출 (일본어)", "ja"},
		{"whisper_en_track2.vtt", "Whisper 추출 (영어 · 트랙 2)", "en"},
		{"qwen3_ja_1_7b_track1.vtt", "Qwen 추출 (일본어 · 1.7B · 트랙 1)", "ja"},
		{"qwen3_ko_0_6b_track1_lyrics.vtt", "Qwen 추출 · 가사 보정 (한국어 · 0.6B · 트랙 1)", "ko"},
		{"upload_zh.ass", "upload_zh.ass", ""},
		{"translate_ko_gemini.vtt", "Gemini 번역 (한국어)", "ko"},
	} {
		label, lang := generatedSubtitleLabel(tt.name)
		if label != tt.label || lang != tt.lang {
			t.Fatalf("%s: %s / %s", tt.name, label, lang)
		}
	}
}

func TestTranslationLabelsRecoverActualSourceWithoutHistory(t *testing.T) {
	for _, source := range []SubtitleEntry{
		{ID: "external:Episode.cht.ass", Label: "cht", Type: "external"},
		{ID: "embedded:4", Label: "繁體中文", Type: "embedded"},
		{ID: "generated:whisper_ja.vtt", Label: "Whisper 추출 (일본어)", Type: "generated"},
		{ID: "generated:qwen3_ja_1_7b_track1.vtt", Label: "Qwen 추출 (일본어 · 1.7B · 트랙 1)", Type: "generated"},
	} {
		translation := translatedEntry(source.ID)
		entries := []SubtitleEntry{source, translation}
		applyTranslationLabels(entries, nil)
		if want := "Gemini 번역 (한국어) ← " + subtitleSourceLabel(source); entries[1].Label != want {
			t.Fatal(entries[1].Label, want)
		}
		if entries[1].ID != translation.ID || entries[1].Format != "ass" {
			t.Fatal("표시 이름 이외의 값 변경")
		}
	}
}

func TestTranslationLabelsUseHistoryForDeletedSourceAndRejectMismatchedHash(t *testing.T) {
	source := "external:Deleted.cht.ass"
	translation := translatedEntry(source)
	entries := []SubtitleEntry{translation}
	applyTranslationLabels(entries, map[string]job.TranslationSource{translation.ID: {ID: source, Label: "외부 자막 원래 이름.cht.ass"}})
	if !strings.HasSuffix(entries[0].Label, "← 외부 자막 원래 이름.cht.ass") {
		t.Fatal(entries)
	}
	entries = []SubtitleEntry{translation}
	applyTranslationLabels(entries, map[string]job.TranslationSource{translation.ID: {ID: "generated:whisper_ja.vtt", Label: "잘못된 출처"}})
	if !strings.HasSuffix(entries[0].Label, "← 원본 정보 없음") {
		t.Fatal(entries)
	}
	entries = []SubtitleEntry{translation}
	applyTranslationLabels(entries, map[string]job.TranslationSource{translation.ID: {ID: source}})
	if !strings.HasSuffix(entries[0].Label, "← 외부 자막 Deleted.cht.ass") {
		t.Fatal(entries)
	}
}

func TestLegacyTranslationWithoutHashNeedsEvidence(t *testing.T) {
	translation := SubtitleEntry{ID: "generated:translate_ko_gemini.vtt", Label: "Gemini 번역 (한국어)", Type: "generated"}
	entries := []SubtitleEntry{{ID: "generated:whisper_ja.vtt", Label: "Whisper 추출 (일본어)", Type: "generated"}, translation}
	applyTranslationLabels(entries, nil)
	if !strings.HasSuffix(entries[1].Label, "원본 정보 없음") {
		t.Fatal(entries)
	}
	entries = []SubtitleEntry{translation}
	applyTranslationLabels(entries, map[string]job.TranslationSource{translation.ID: {ID: "generated:qwen3_ja_1_7b_track1.vtt"}})
	if !strings.Contains(entries[0].Label, "← Qwen 추출") {
		t.Fatal(entries)
	}
}

func TestSubtitleListUsesNamesWithoutRenamingFiles(t *testing.T) {
	media, generated := t.TempDir(), t.TempDir()
	video := filepath.Join(media, "Episode.mkv")
	if err := os.WriteFile(video, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(media, "Episode.cht.ass"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(generated, videoHash("Episode.mkv"))
	if err := os.MkdirAll(folder, 0700); err != nil {
		t.Fatal(err)
	}
	translation := translatedEntry("external:Episode.cht.ass")
	name := strings.TrimPrefix(translation.ID, "generated:")
	if err := os.WriteFile(filepath.Join(folder, name), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	entries := NewSubtitleHandler(media, generated, nil, nil).subtitleEntries("Episode.mkv", video, false)
	if len(entries) != 2 || entries[1].Label != "Gemini 번역 (한국어) ← 외부 자막 Episode.cht.ass" || entries[1].ID != translation.ID {
		t.Fatal(entries)
	}
	if _, err := os.Stat(filepath.Join(folder, name)); err != nil {
		t.Fatal(err)
	}
}
