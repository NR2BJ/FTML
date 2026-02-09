package ffmpeg

import (
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
)

type ProbeResult struct {
	Format   ProbeFormat    `json:"format"`
	Streams  []ProbeStream  `json:"streams"`
	Chapters []ProbeChapter `json:"chapters,omitempty"`
}

type ProbeChapter struct {
	ID        int               `json:"id"`
	TimeBase  string            `json:"time_base"`
	Start     int64             `json:"start"`
	StartTime string            `json:"start_time"`
	End       int64             `json:"end"`
	EndTime   string            `json:"end_time"`
	Tags      map[string]string `json:"tags,omitempty"`
}

type ProbeFormat struct {
	Filename   string `json:"filename"`
	FormatName string `json:"format_name"` // e.g. "matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2"
	Duration   string `json:"duration"`
	Size       string `json:"size"`
	BitRate    string `json:"bit_rate"`
}

type ProbeStream struct {
	Index         int    `json:"index"`
	CodecName     string `json:"codec_name"`
	CodecType     string `json:"codec_type"` // video, audio, subtitle
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
	PixFmt        string `json:"pix_fmt,omitempty"`
	RFrameRate    string `json:"r_frame_rate,omitempty"`
	BitRate       string `json:"bit_rate,omitempty"`
	SampleRate    string `json:"sample_rate,omitempty"`
	Channels      int    `json:"channels,omitempty"`
	ChannelLayout string `json:"channel_layout,omitempty"`
	Tags          map[string]string `json:"tags,omitempty"`
}

// AudioStreamInfo describes a single audio stream for track selection.
type AudioStreamInfo struct {
	Index         int    `json:"index"`                    // absolute stream index in the file
	StreamIndex   int    `json:"stream_index"`             // audio-only index (0, 1, 2...)
	CodecName     string `json:"codec_name"`
	Channels      int    `json:"channels"`
	ChannelLayout string `json:"channel_layout,omitempty"`
	SampleRate    string `json:"sample_rate,omitempty"`
	BitRate       string `json:"bit_rate,omitempty"`
	Language      string `json:"language,omitempty"`
	Title         string `json:"title,omitempty"`
}

// ChapterInfo describes a single chapter marker.
type ChapterInfo struct {
	Title     string  `json:"title"`
	StartTime float64 `json:"start_time"`
	EndTime   float64 `json:"end_time"`
}

type MediaInfo struct {
	Duration     string            `json:"duration"`
	Size         string            `json:"size"`
	BitRate      string            `json:"bit_rate"`
	Container    string            `json:"container"` // normalized: "mkv", "mp4", "avi", etc.
	PixFmt       string            `json:"pix_fmt"`   // e.g. "yuv420p", "yuv420p10le"
	VideoCodec   string            `json:"video_codec"`
	AudioCodec   string            `json:"audio_codec"`
	Width        int               `json:"width"`
	Height       int               `json:"height"`
	FrameRate    string            `json:"frame_rate"`
	Streams      []ProbeStream     `json:"streams"`
	AudioStreams []AudioStreamInfo  `json:"audio_streams,omitempty"`
	Chapters    []ChapterInfo      `json:"chapters,omitempty"`
}

func Probe(filePath string) (*MediaInfo, error) {
	cmd := exec.Command("ffprobe",
		"-v", "quiet",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		"-show_chapters",
		filePath,
	)

	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var result ProbeResult
	if err := json.Unmarshal(output, &result); err != nil {
		return nil, err
	}

	info := &MediaInfo{
		Duration:  result.Format.Duration,
		Size:      result.Format.Size,
		BitRate:   result.Format.BitRate,
		Container: normalizeContainerName(result.Format.FormatName),
		Streams:   result.Streams,
	}

	audioIdx := 0
	for _, s := range result.Streams {
		switch s.CodecType {
		case "video":
			if info.VideoCodec == "" {
				info.VideoCodec = s.CodecName
				info.Width = s.Width
				info.Height = s.Height
				info.FrameRate = s.RFrameRate
				info.PixFmt = s.PixFmt
			}
		case "audio":
			if info.AudioCodec == "" {
				info.AudioCodec = s.CodecName
			}
			// Collect all audio streams for track selection
			as := AudioStreamInfo{
				Index:         s.Index,
				StreamIndex:   audioIdx,
				CodecName:     s.CodecName,
				Channels:      s.Channels,
				ChannelLayout: s.ChannelLayout,
				SampleRate:    s.SampleRate,
				BitRate:       s.BitRate,
			}
			if s.Tags != nil {
				as.Language = s.Tags["language"]
				as.Title = s.Tags["title"]
			}
			info.AudioStreams = append(info.AudioStreams, as)
			audioIdx++
		}
	}

	// Extract chapters
	for _, ch := range result.Chapters {
		title := ""
		if ch.Tags != nil {
			title = ch.Tags["title"]
		}
		startTime := parseFloat(ch.StartTime)
		endTime := parseFloat(ch.EndTime)
		if startTime >= 0 {
			info.Chapters = append(info.Chapters, ChapterInfo{
				Title:     title,
				StartTime: startTime,
				EndTime:   endTime,
			})
		}
	}

	return info, nil
}

// parseFloat safely converts a string to float64, returning 0 on error.
func parseFloat(s string) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}

// normalizeContainerName maps ffprobe format_name to a simple container name.
// ffprobe returns comma-separated format names like "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2".
func normalizeContainerName(formatName string) string {
	f := strings.ToLower(strings.TrimSpace(formatName))
	switch {
	case strings.Contains(f, "matroska"):
		return "mkv"
	case strings.Contains(f, "mov") || strings.Contains(f, "mp4"):
		return "mp4"
	case strings.Contains(f, "avi"):
		return "avi"
	case strings.Contains(f, "webm"):
		return "webm"
	case strings.Contains(f, "mpegts"):
		return "ts"
	default:
		// Return first format name for unknown containers
		if idx := strings.Index(f, ","); idx > 0 {
			return f[:idx]
		}
		return f
	}
}
