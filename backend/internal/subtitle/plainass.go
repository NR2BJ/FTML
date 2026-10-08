package subtitle

import (
	"context"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var assOverride = regexp.MustCompile(`\{[^}]*\}`)
var karaokeTag = regexp.MustCompile(`\\(?:kf|ko|k|K)\d+`)

type assEvent struct {
	line                int
	comment             bool
	start, end          float64
	style, effect, text string
	fields              []string
	effectColumn        int
}

// NormalizeASSForText는 Aegisub가 보관한 원문 가사와 대응 효과가 함께 있을 때만
// 글자별 효과를 원래 문장으로 복원한다. 원본 파일이나 일반 대사는 바꾸지 않는다.
func NormalizeASSForText(data []byte) []byte {
	if !utf8.Valid(data) {
		return data
	}
	lines := strings.Split(strings.ReplaceAll(strings.TrimPrefix(string(data), "\ufeff"), "\r\n", "\n"), "\n")
	events := parseASSEvents(lines)
	replacements := make(map[int]string)
	removed := make(map[int]bool)
	for _, source := range events {
		if !source.comment || source.effect != "karaoke" || !karaokeTag.MatchString(source.text) || source.end <= source.start {
			continue
		}
		ambiguous := false
		for _, other := range events {
			if other.line != source.line && other.comment && other.effect == "karaoke" && other.style == source.style && other.start < source.end && other.end > source.start {
				ambiguous = true
				break
			}
		}
		if ambiguous {
			continue
		}
		var fragments []assEvent
		covered := make(map[rune]bool)
		for _, event := range events {
			if event.comment || event.effect != "fx" || event.style != source.style {
				continue
			}
			// 원문 구간 안의 효과와 그 시작에 끝나는 도입 효과만 연결한다.
			if !(event.start >= source.start && event.end <= source.end || event.end == source.start) {
				continue
			}
			fragments = append(fragments, event)
			for _, r := range plainASSText(event.text) {
				covered[r] = true
			}
		}
		text := plainASSText(source.text)
		complete := strings.TrimSpace(text) != "" && len(fragments) > 1
		for _, r := range text {
			if !unicode.IsSpace(r) && !covered[r] {
				complete = false
			}
		}
		if !complete {
			continue
		}
		fields := append([]string(nil), source.fields...)
		fields[source.effectColumn] = ""
		replacements[source.line] = "Dialogue: " + strings.Join(fields, ",")
		for _, fragment := range fragments {
			removed[fragment.line] = true
		}
	}
	if len(replacements) == 0 {
		return data
	}
	var result []string
	for i, line := range lines {
		if replacement, ok := replacements[i]; ok {
			result = append(result, replacement)
		} else if !removed[i] {
			result = append(result, line)
		}
	}
	return []byte(strings.Join(result, "\n"))
}

func plainASSText(text string) string {
	return strings.NewReplacer(`\N`, "\n", `\n`, "\n", `\h`, " ").Replace(assOverride.ReplaceAllString(text, ""))
}

func parseASSEvents(lines []string) []assEvent {
	var result []assEvent
	var columns map[string]int
	inEvents := false
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			inEvents = strings.EqualFold(line, "[Events]")
			columns = nil
			continue
		}
		if !inEvents {
			continue
		}
		kind, body, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		body = strings.TrimSpace(body)
		if strings.EqualFold(kind, "Format") {
			columns = make(map[string]int)
			for j, name := range strings.Split(body, ",") {
				name = strings.ToLower(strings.TrimSpace(name))
				if _, duplicate := columns[name]; name == "" || duplicate {
					columns = nil
					break
				}
				columns[name] = j
			}
			continue
		}
		comment := strings.EqualFold(kind, "Comment")
		if (!comment && !strings.EqualFold(kind, "Dialogue")) || len(columns) == 0 {
			continue
		}
		valid := true
		for _, name := range []string{"start", "end", "style", "effect", "text"} {
			if _, ok := columns[name]; !ok {
				valid = false
			}
		}
		if !valid || columns["text"] != len(columns)-1 {
			continue
		}
		fields := strings.SplitN(body, ",", len(columns))
		if len(fields) != len(columns) {
			continue
		}
		start, okStart := assTime(fields[columns["start"]])
		end, okEnd := assTime(fields[columns["end"]])
		if !okStart || !okEnd || end < start {
			continue
		}
		result = append(result, assEvent{line: i, comment: comment, start: start, end: end,
			style: strings.TrimSpace(fields[columns["style"]]), effect: strings.ToLower(strings.TrimSpace(fields[columns["effect"]])),
			text: fields[columns["text"]], fields: fields, effectColumn: columns["effect"]})
	}
	return result
}

func assTime(value string) (float64, bool) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 3 {
		return 0, false
	}
	h, e1 := strconv.Atoi(parts[0])
	m, e2 := strconv.Atoi(parts[1])
	s, e3 := strconv.ParseFloat(parts[2], 64)
	return float64(h*3600+m*60) + s, e1 == nil && e2 == nil && e3 == nil && h >= 0 && m >= 0 && m < 60 && s >= 0 && s < 60 && !math.IsNaN(s)
}

// ConvertASSFile은 표시/번역/일반 자막 내보내기에 같은 문장 복원을 적용한다.
func ConvertASSFile(ctx context.Context, path, format string) ([]byte, error) {
	if format == "vtt" {
		format = "webvtt"
	}
	if format != "webvtt" && format != "srt" {
		return nil, fmt.Errorf("지원하지 않는 일반 자막 형식")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxDocumentBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxDocumentBytes {
		return nil, fmt.Errorf("자막 크기 제한 초과")
	}
	data, err = DecodeText(data)
	if err != nil {
		return nil, err
	}
	return (Document{Data: data, Format: "ass"}).Convert(ctx, format)
}
