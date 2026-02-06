package ffmpeg

import (
	"encoding/json"
	"os/exec"
)

type ProbeResult struct {
	Format  ProbeFormat   `json:"format"`
	Streams []ProbeStream `json:"streams"`
}

type ProbeFormat struct {
	Filename string `json:"filename"`
	Duration string `json:"duration"`
	Size     string `json:"size"`
	BitRate  string `json:"bit_rate"`
}

type ProbeStream struct {
	Index         int    `json:"index"`
	CodecName     string `json:"codec_name"`
	CodecType     string `json:"codec_type"` // video, audio, subtitle
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
	RFrameRate    string `json:"r_frame_rate,omitempty"`
	BitRate       string `json:"bit_rate,omitempty"`
	SampleRate    string `json:"sample_rate,omitempty"`
	Channels      int    `json:"channels,omitempty"`
	ChannelLayout string `json:"channel_layout,omitempty"`
	Tags          map[string]string `json:"tags,omitempty"`
}

type MediaInfo struct {
	Duration    string        `json:"duration"`
	Size        string        `json:"size"`
	BitRate     string        `json:"bit_rate"`
	VideoCodec  string        `json:"video_codec"`
	AudioCodec  string        `json:"audio_codec"`
	Width       int           `json:"width"`
	Height      int           `json:"height"`
	FrameRate   string        `json:"frame_rate"`
	Streams     []ProbeStream `json:"streams"`
}

func Probe(filePath string) (*MediaInfo, error) {
	cmd := exec.Command("ffprobe",
		"-v", "quiet",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
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
		Duration: result.Format.Duration,
		Size:     result.Format.Size,
		BitRate:  result.Format.BitRate,
		Streams:  result.Streams,
	}

	for _, s := range result.Streams {
		switch s.CodecType {
		case "video":
			if info.VideoCodec == "" {
				info.VideoCodec = s.CodecName
				info.Width = s.Width
				info.Height = s.Height
				info.FrameRate = s.RFrameRate
			}
		case "audio":
			if info.AudioCodec == "" {
				info.AudioCodec = s.CodecName
			}
		}
	}

	return info, nil
}
