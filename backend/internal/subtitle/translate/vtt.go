package translate

import (
	"fmt"
	"html"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Matches both HH:MM:SS.mmm and MM:SS.mmm timestamp formats
var timestampRe = regexp.MustCompile(`^(\d{1,6}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,6}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$`)

// htmlTagRe strips VTT/HTML formatting tags like <i>, </b>, <v Name>, <c.class>, etc.
var htmlTagRe = regexp.MustCompile(`<[^>]+>`)

// ParseVTT parses WebVTT content into subtitle cues
func ParseVTT(content string) []SubtitleCue {
	// Strip UTF-8 BOM if present
	content = strings.TrimPrefix(content, "\xEF\xBB\xBF")

	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	var cues []SubtitleCue
	var currentCue *SubtitleCue
	index := 0
	skipBlock := false // for NOTE/STYLE blocks

	for _, line := range lines {
		line = strings.TrimSpace(line)

		// Empty line: finalize current cue, end skip block
		if line == "" {
			if validCue(currentCue) {
				cues = append(cues, *currentCue)
			}
			currentCue = nil
			skipBlock = false
			continue
		}

		// Skip lines inside NOTE/STYLE blocks
		if skipBlock {
			continue
		}

		// Skip WEBVTT header line (may include description: "WEBVTT - Some title")
		if strings.HasPrefix(line, "WEBVTT") {
			continue
		}

		// Skip NOTE and STYLE blocks (block continues until next empty line)
		if currentCue == nil && (line == "NOTE" || strings.HasPrefix(line, "NOTE ") || line == "STYLE" || line == "REGION") {
			skipBlock = true
			continue
		}

		// Skip VTT metadata header lines (Kind:, Language:, etc.)
		if currentCue == nil && strings.Contains(line, ":") && !timestampRe.MatchString(line) {
			continue
		}

		// Check for timestamp line
		if matches := timestampRe.FindStringSubmatch(line); len(matches) == 3 {
			if validCue(currentCue) {
				cues = append(cues, *currentCue)
			}
			index++
			currentCue = &SubtitleCue{
				Index: index,
				Start: parseTimestamp(matches[1]),
				End:   parseTimestamp(matches[2]),
			}
			continue
		}

		// Skip cue index numbers (pure digits)
		if _, err := strconv.Atoi(line); err == nil && currentCue == nil {
			continue
		}

		// Text line — strip HTML/VTT formatting tags (<i>, </b>, <v Name>, etc.)
		if currentCue != nil {
			cleaned := html.UnescapeString(htmlTagRe.ReplaceAllString(line, ""))
			if cleaned == "" {
				continue
			}
			if currentCue.Text != "" {
				currentCue.Text += "\n"
			}
			currentCue.Text += cleaned
		}
	}

	if validCue(currentCue) {
		cues = append(cues, *currentCue)
	}

	return cues
}

// CuesToVTT converts subtitle cues back to WebVTT format
func CuesToVTT(cues []SubtitleCue) string {
	var sb strings.Builder
	sb.WriteString("WEBVTT\n\n")

	idx := 0
	for _, cue := range cues {
		// Skip cues with empty text
		if !validCue(&cue) {
			continue
		}
		idx++
		sb.WriteString(fmt.Sprintf("%d\n", idx))
		sb.WriteString(fmt.Sprintf("%s --> %s\n", formatTimestamp(cue.Start), formatTimestamp(cue.End)))
		sb.WriteString(html.EscapeString(cue.Text))
		sb.WriteString("\n\n")
	}

	return sb.String()
}

func parseTimestamp(ts string) float64 {
	ts = strings.Replace(ts, ",", ".", 1)
	parts := strings.Split(ts, ":")
	for i, part := range parts {
		value, err := strconv.ParseFloat(part, 64)
		if err != nil || value < 0 || (i > 0 || len(parts) == 2) && value >= 60 {
			return math.NaN()
		}
	}
	switch len(parts) {
	case 3:
		// HH:MM:SS.mmm
		var h, m, s int
		var ms int
		fmt.Sscanf(ts, "%d:%d:%d.%d", &h, &m, &s, &ms)
		return float64(h*3600+m*60+s) + float64(ms)/1000.0
	case 2:
		// MM:SS.mmm (FFmpeg short format)
		var m, s int
		var ms int
		fmt.Sscanf(ts, "%d:%d.%d", &m, &s, &ms)
		return float64(m*60+s) + float64(ms)/1000.0
	default:
		return 0
	}
}

func validCue(cue *SubtitleCue) bool {
	return cue != nil && strings.TrimSpace(cue.Text) != "" && !math.IsNaN(cue.Start) && !math.IsNaN(cue.End) && !math.IsInf(cue.Start, 0) && !math.IsInf(cue.End, 0) && cue.Start >= 0 && cue.End > cue.Start
}

func formatTimestamp(seconds float64) string {
	totalMs := int(math.Round(seconds * 1000))
	h := totalMs / 3600000
	totalMs %= 3600000
	m := totalMs / 60000
	totalMs %= 60000
	s := totalMs / 1000
	ms := totalMs % 1000
	return fmt.Sprintf("%02d:%02d:%02d.%03d", h, m, s, ms)
}
