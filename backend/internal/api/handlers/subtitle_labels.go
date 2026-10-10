package handlers

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/video-stream/backend/internal/job"
)

var translationFilename = regexp.MustCompile(`^translate_([^_]+)_([^_]+)(?:_([0-9a-f]{16}))?\.[^.]+$`)

func subtitleLanguageLabel(lang string) string {
	if label, ok := map[string]string{"ja": "일본어", "jpn": "일본어", "ko": "한국어", "kor": "한국어", "en": "영어", "eng": "영어", "zh": "중국어", "zho": "중국어", "chi": "중국어", "chs": "중국어 간체", "cht": "중국어 번체", "auto": "자동 감지"}[lang]; ok {
		return label
	}
	return lang
}

func generatedSubtitleLabel(name string) (string, string) {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	for _, model := range []struct{ prefix, label string }{{"whisper_", "Whisper 추출"}, {"qwen3_", "Qwen 추출"}} {
		if !strings.HasPrefix(base, model.prefix) {
			continue
		}
		detail := strings.TrimPrefix(base, model.prefix)
		parts := strings.Split(detail, "_")
		lang := parts[0]
		label := model.label
		if strings.HasSuffix(base, "_lyrics") {
			label += " · 가사 보정"
		}
		values := []string{subtitleLanguageLabel(lang)}
		if strings.Contains(detail, "_1_7b") {
			values = append(values, "1.7B")
		} else if strings.Contains(detail, "_0_6b") {
			values = append(values, "0.6B")
		}
		for _, part := range parts[1:] {
			if strings.HasPrefix(part, "track") {
				values = append(values, "트랙 "+strings.TrimPrefix(part, "track"))
			}
		}
		return label + " (" + strings.Join(values, " · ") + ")", lang
	}
	if parts := translationFilename.FindStringSubmatch(name); parts != nil {
		engine := parts[2]
		if engine == "gemini" {
			engine = "Gemini"
		}
		return engine + " 번역 (" + subtitleLanguageLabel(parts[1]) + ")", parts[1]
	}
	return name, ""
}

func subtitleSourceLabel(entry SubtitleEntry) string {
	if entry.Type == "external" {
		return "외부 자막 " + strings.TrimPrefix(entry.ID, "external:")
	}
	if entry.Type == "embedded" {
		return fmt.Sprintf("내장 자막 %s [%s]", entry.Label, strings.TrimPrefix(entry.ID, "embedded:"))
	}
	return entry.Label
}

func applyTranslationLabels(entries []SubtitleEntry, history map[string]job.TranslationSource) {
	byID := make(map[string]SubtitleEntry, len(entries))
	byHash := make(map[string][]string, len(entries))
	for _, entry := range entries {
		byID[entry.ID] = entry
		digest := sha256.Sum256([]byte(entry.ID))
		key := fmt.Sprintf("%x", digest[:8])
		byHash[key] = append(byHash[key], entry.ID)
	}
	for i := range entries {
		entry := &entries[i]
		if !strings.HasPrefix(entry.ID, "generated:") {
			continue
		}
		parts := translationFilename.FindStringSubmatch(strings.TrimPrefix(entry.ID, "generated:"))
		if parts == nil {
			continue
		}
		source := history[entry.ID]
		// 이력은 정확히 같은 출력/원본 조합이어야 한다. 해시가 없는 구버전만 이력을 그대로 쓴다.
		if source.ID != "" && parts[3] != "" {
			digest := sha256.Sum256([]byte(source.ID))
			if fmt.Sprintf("%x", digest[:8]) != parts[3] {
				source = job.TranslationSource{}
			}
		}
		if source.ID == "" && len(byHash[parts[3]]) == 1 {
			source.ID = byHash[parts[3]][0]
		}
		if source.Label == "" && source.ID != "" {
			if original, ok := byID[source.ID]; ok {
				source.Label = subtitleSourceLabel(original)
			} else if kind, name, ok := strings.Cut(source.ID, ":"); ok {
				label, _ := generatedSubtitleLabel(name)
				source.Label = subtitleSourceLabel(SubtitleEntry{ID: source.ID, Label: label, Type: kind})
			}
		}
		if source.Label == "" {
			source.Label = "원본 정보 없음"
		}
		entry.Label += " ← " + source.Label
	}
}
