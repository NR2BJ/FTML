package ffmpeg

import "testing"

func TestPresetsRespectVideoBitDepth(t *testing.T) {
	for _, tc := range []struct {
		name, codec, pixelFormat, container string
		main10, original, passthrough       bool
	}{
		{"HEVC Main MP4", "hevc", "yuv420p", "mp4", false, true, false},
		{"HEVC Main10 unsupported MP4", "hevc", "yuv420p10le", "mp4", false, false, false},
		{"HEVC Main10 supported MP4", "hevc", "yuv420p10le", "mp4", true, true, false},
		{"HEVC Main10 unsupported MKV", "hevc", "yuv420p10le", "mkv", false, false, false},
		{"HEVC Main10 supported MKV", "hevc", "yuv420p10le", "mkv", true, false, true},
		{"H264 High10 MP4", "h264", "yuv420p10le", "mp4", true, false, false},
		{"H264 High10 MKV", "h264", "yuv420p10le", "mkv", true, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			info := &MediaInfo{Height: 1080, Width: 1920, VideoCodec: tc.codec, PixFmt: tc.pixelFormat, Container: tc.container, AudioCodec: "aac"}
			options := GeneratePresets(info, CodecH264, nil, BrowserCodecs{H264: true, HEVC: true, HEVC10: tc.main10, AAC: true})
			var original, passthrough, transcode bool
			for _, option := range options {
				switch option.Value {
				case "original":
					original = option.CanOriginal
				case "passthrough":
					passthrough = true
				case "1080p":
					transcode = true
				}
			}
			if original != tc.original || passthrough != tc.passthrough || !transcode {
				t.Fatalf("original=%v passthrough=%v transcode=%v", original, passthrough, transcode)
			}
		})
	}
}

func TestCompatibilityTranscodeKeepsHardwareEncoder(t *testing.T) {
	caps := &HWCapabilities{Encoders: []EncoderInfo{
		{Codec: CodecAV1, Encoder: "av1_vaapi", HWAccel: "vaapi", Device: "/dev/dri/renderD128"},
		{Codec: CodecH264, Encoder: "h264_vaapi", HWAccel: "vaapi", Device: "/dev/dri/renderD128"},
	}}
	encoder := GetEncoderForCodec(caps, CodecH264)
	info := &MediaInfo{Height: 1080, Width: 1920, VideoCodec: "hevc", PixFmt: "yuv420p10le", Container: "mkv"}
	options := GeneratePresets(info, CodecH264, encoder, BrowserCodecs{H264: true, AAC: true})
	params := GetTranscodeParams("1080p", options, encoder)
	if params == nil || params.Encoder != "h264_vaapi" || params.VideoCodec != "h264" || params.AudioCodec != "aac" || params.Height != 1080 {
		t.Fatalf("unexpected compatibility transcode: %+v", params)
	}
}
