package subtitle

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
)

type TextEvent struct {
	ID         int
	Start, End float64
	Text       string
}

var drawingTag = regexp.MustCompile(`\\p[1-9][0-9]*\b`)

type ASSTranslation struct {
	lines     []string
	events    []assEvent
	Texts     []TextEvent
	Fallbacks int
}

// 효과 명령은 번역기에 맡기지 않는다. 글자별 효과는 원본을 보존하고 번역을 별도 대사로 표시한다.
func PrepareASSTranslation(data []byte) *ASSTranslation {
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	plan := &ASSTranslation{lines: lines}
	restored := make(map[string]bool)
	normalized := NormalizeASSForText(data)
	if !bytes.Equal(normalized, data) {
		for _, event := range parseASSEvents(strings.Split(string(normalized), "\n")) {
			if !event.comment && karaokeTag.MatchString(event.text) {
				restored[assEventKey(event)] = true
			}
		}
	}
	for _, event := range parseASSEvents(lines) {
		if event.comment && (event.effect != "karaoke" || !restored[assEventKey(event)]) {
			continue
		}
		if event.effect == "fx" || event.end <= event.start {
			continue
		}
		if drawingTag.MatchString(event.text) {
			continue
		}
		text := strings.TrimSpace(plainASSText(event.text))
		if text == "" {
			continue
		}
		plan.events = append(plan.events, event)
		plan.Texts = append(plan.Texts, TextEvent{ID: len(plan.events), Start: event.start, End: event.end, Text: text})
	}
	return plan
}

func assEventKey(event assEvent) string {
	return fmt.Sprintf("%s\x00%f\x00%f\x00%s", event.style, event.start, event.end, event.text)
}

func (p *ASSTranslation) Render(translations map[int]string) ([]byte, error) {
	if len(translations) != len(p.events) {
		return nil, fmt.Errorf("ASS 번역 문장 수 불일치")
	}
	lines := append([]string(nil), p.lines...)
	p.Fallbacks = 0
	for i, event := range p.events {
		text, ok := translations[i+1]
		if !ok || strings.TrimSpace(text) == "" {
			return nil, fmt.Errorf("ASS 번역 문장 누락")
		}
		// 번역문에서 ASS 명령이나 새 이벤트를 삽입하지 못하게 한다.
		text = strings.NewReplacer("\\", "＼", "{", "｛", "}", "｝", "\r", "", "\n", `\N`).Replace(strings.TrimSpace(text))
		prefix, remaining := "", event.text
		for strings.HasPrefix(remaining, "{") {
			end := strings.IndexByte(remaining, '}')
			if end < 0 {
				break
			}
			prefix += remaining[:end+1]
			remaining = remaining[end+1:]
		}
		fields := append([]string(nil), event.fields...)
		if event.comment || karaokeTag.MatchString(event.text) || assOverride.MatchString(remaining) {
			// 언어별 글자 수/어순이 달라진 효과는 임의로 재배열하지 않는다.
			p.Fallbacks++
			fields[event.effectColumn] = ""
			fields[len(fields)-1] = `{\r\an2}` + text
			lines[event.line] += "\nDialogue: " + strings.Join(fields, ",")
		} else {
			fields[len(fields)-1] = prefix + text
			lines[event.line] = "Dialogue: " + strings.Join(fields, ",")
		}
	}
	return []byte(strings.Join(lines, "\n")), nil
}
