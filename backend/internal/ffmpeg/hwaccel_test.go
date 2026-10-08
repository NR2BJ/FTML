package ffmpeg

import "testing"

func TestNegotiationPrefersRealTimeHardware(t *testing.T) {
	caps := &HWCapabilities{Encoders: []EncoderInfo{{Codec: CodecAV1, Encoder: "libsvtav1"}, {Codec: CodecHEVC, Encoder: "hevc_vaapi", HWAccel: "vaapi", Device: "test"}, {Codec: CodecH264, Encoder: "libx264"}}}
	if got := NegotiateCodec(caps, BrowserCodecs{AV1: true, HEVC: true, H264: true}); got.Encoder != "hevc_vaapi" {
		t.Fatalf("slow automatic encoder: %+v", got)
	}
	if got := NegotiateCodec(caps, BrowserCodecs{AV1: true, H264: true}); got.Encoder != "libx264" {
		t.Fatalf("CPU AV1 selected: %+v", got)
	}
	for _, mode := range []string{"hardware", "hybrid"} {
		got, err := ResolveEncoder(caps, CodecHEVC, mode)
		if err != nil || got.Device != "test" || (got.HWAccel == "vaapi") != (mode == "hardware") {
			t.Fatalf("bad %s: %+v %v", mode, got, err)
		}
	}
	for _, request := range []struct {
		codec Codec
		mode  string
	}{{CodecAV1, "hardware"}, {CodecHEVC, "software"}, {CodecH264, "invalid"}, {Codec("bogus"), ""}} {
		if _, err := ResolveEncoder(caps, request.codec, request.mode); err == nil {
			t.Fatalf("silently substituted %+v", request)
		}
	}
}
