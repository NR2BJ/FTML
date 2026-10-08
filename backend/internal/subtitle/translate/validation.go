package translate

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var errInvalidTranslation = errors.New("번역 응답이 불완전합니다")

type cueTranslation struct {
	ID   *int   `json:"id"`
	Text string `json:"text"`
}

func parseIdentifiedTranslations(cues []SubtitleCue, content string) ([]SubtitleCue, error) {
	var entries []cueTranslation
	if err := json.Unmarshal([]byte(content), &entries); err != nil {
		return nil, fmt.Errorf("%w: JSON 형식 오류", errInvalidTranslation)
	}
	if len(entries) != len(cues) {
		return nil, fmt.Errorf("%w: %d개 중 %d개 반환", errInvalidTranslation, len(cues), len(entries))
	}
	byID := make(map[int]string, len(entries))
	for _, entry := range entries {
		if entry.ID == nil || strings.TrimSpace(entry.Text) == "" {
			return nil, fmt.Errorf("%w: 자막 번호 또는 번역문 누락", errInvalidTranslation)
		}
		if _, exists := byID[*entry.ID]; exists {
			return nil, fmt.Errorf("%w: 자막 번호 %d 중복", errInvalidTranslation, *entry.ID)
		}
		byID[*entry.ID] = entry.Text
	}
	result := make([]SubtitleCue, len(cues))
	for i, cue := range cues {
		text, ok := byID[cue.Index]
		if !ok {
			return nil, fmt.Errorf("%w: 자막 번호 %d 누락", errInvalidTranslation, cue.Index)
		}
		result[i] = cue
		result[i].Text = text
		delete(byID, cue.Index)
	}
	return result, nil
}

func validateTranslatedCues(source, translated []SubtitleCue) error {
	if len(source) != len(translated) {
		return errInvalidTranslation
	}
	for i, cue := range source {
		other := translated[i]
		if other.Index != cue.Index || other.Start != cue.Start || other.End != cue.End || strings.TrimSpace(other.Text) == "" {
			return fmt.Errorf("%w: 자막 번호 %d 불일치", errInvalidTranslation, cue.Index)
		}
	}
	return nil
}
