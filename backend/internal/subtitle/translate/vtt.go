package translate

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var timestampRe = regexp.MustCompile(`(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})`)

// ParseVTT parses WebVTT content into subtitle cues
func ParseVTT(content string) []SubtitleCue {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	var cues []SubtitleCue
	var currentCue *SubtitleCue
	index := 0

	for _, line := range lines {
		line = strings.TrimSpace(line)

		// Skip WEBVTT header and empty lines
		if line == "WEBVTT" || line == "" {
			if currentCue != nil && currentCue.Text != "" {
				cues = append(cues, *currentCue)
				currentCue = nil
			}
			continue
		}

		// Check for timestamp line
		if matches := timestampRe.FindStringSubmatch(line); len(matches) == 3 {
			if currentCue != nil && currentCue.Text != "" {
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

		// Text line
		if currentCue != nil {
			if currentCue.Text != "" {
				currentCue.Text += "\n"
			}
			currentCue.Text += line
		}
	}

	if currentCue != nil && currentCue.Text != "" {
		cues = append(cues, *currentCue)
	}

	return cues
}

// CuesToVTT converts subtitle cues back to WebVTT format
func CuesToVTT(cues []SubtitleCue) string {
	var sb strings.Builder
	sb.WriteString("WEBVTT\n\n")

	for i, cue := range cues {
		sb.WriteString(fmt.Sprintf("%d\n", i+1))
		sb.WriteString(fmt.Sprintf("%s --> %s\n", formatTimestamp(cue.Start), formatTimestamp(cue.End)))
		sb.WriteString(cue.Text)
		sb.WriteString("\n\n")
	}

	return sb.String()
}

func parseTimestamp(ts string) float64 {
	ts = strings.Replace(ts, ",", ".", 1)
	var h, m, s int
	var ms int
	fmt.Sscanf(ts, "%d:%d:%d.%d", &h, &m, &s, &ms)
	return float64(h*3600+m*60+s) + float64(ms)/1000.0
}

func formatTimestamp(seconds float64) string {
	totalMs := int(seconds * 1000)
	h := totalMs / 3600000
	totalMs %= 3600000
	m := totalMs / 60000
	totalMs %= 60000
	s := totalMs / 1000
	ms := totalMs % 1000
	return fmt.Sprintf("%02d:%02d:%02d.%03d", h, m, s, ms)
}
