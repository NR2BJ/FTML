package ffmpeg

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// Codec represents a video codec family.
type Codec string

const (
	CodecH264 Codec = "h264"
	CodecHEVC Codec = "hevc"
	CodecAV1  Codec = "av1"
	CodecVP9  Codec = "vp9"
)

// EncoderInfo describes one available encoder (hardware or software).
type EncoderInfo struct {
	Codec   Codec  `json:"codec"`   // h264, hevc, av1
	Encoder string `json:"encoder"` // e.g. "h264_vaapi", "libx264"
	HWAccel string `json:"hwaccel"` // "vaapi" or "" for software
	Device  string `json:"device"`  // "/dev/dri/renderD128" or ""
}

// HWCapabilities is the server-wide hardware detection result.
type HWCapabilities struct {
	Encoders  []EncoderInfo `json:"encoders"`
	HWAccel   string        `json:"hwaccel_type"` // "vaapi" or "none"
	Device    string        `json:"device"`
	CanDecode bool          `json:"can_decode"`
}

var (
	serverCaps     *HWCapabilities
	serverCapsOnce sync.Once
)

// VAAPI encoder candidates in priority order (best first).
var vaapiEncoders = []struct {
	Codec   Codec
	Encoder string
}{
	{CodecAV1, "av1_vaapi"},
	{CodecHEVC, "hevc_vaapi"},
	{CodecH264, "h264_vaapi"},
}

// Software encoder fallbacks.
var softwareEncoders = []struct {
	Codec   Codec
	Encoder string
}{
	{CodecH264, "libx264"},
	{CodecHEVC, "libx265"},
	{CodecAV1, "libsvtav1"},
	{CodecVP9, "libvpx-vp9"},
}

// DetectHardware probes the system for available VAAPI encoders and
// builds the server-wide capabilities singleton. Call once at startup.
func DetectHardware() *HWCapabilities {
	serverCapsOnce.Do(func() {
		serverCaps = detectHardware()
	})
	return serverCaps
}

// GetCapabilities returns the cached hardware capabilities.
// Returns nil if DetectHardware has not been called.
func GetCapabilities() *HWCapabilities {
	return serverCaps
}

func detectHardware() *HWCapabilities {
	caps := &HWCapabilities{
		HWAccel: "none",
	}

	// Find a VAAPI render device
	device := findVAAPIDevice()
	if device != "" {
		caps.Device = device
		log.Printf("[HWAccel] Found VAAPI device: %s", device)

		// Test each VAAPI encoder
		for _, enc := range vaapiEncoders {
			if testVAAPIEncoder(device, enc.Encoder) {
				caps.Encoders = append(caps.Encoders, EncoderInfo{
					Codec:   enc.Codec,
					Encoder: enc.Encoder,
					HWAccel: "vaapi",
					Device:  device,
				})
				log.Printf("[HWAccel] Encoder available: %s", enc.Encoder)
			} else {
				log.Printf("[HWAccel] Encoder NOT available: %s", enc.Encoder)
			}
		}

		if len(caps.Encoders) > 0 {
			caps.HWAccel = "vaapi"
			caps.CanDecode = testVAAPIDecoder(device)
			if caps.CanDecode {
				log.Printf("[HWAccel] VAAPI decode: available")
			}
		}
	} else {
		log.Printf("[HWAccel] No VAAPI device found")
	}

	// Always add software fallbacks for codecs not covered by hardware
	caps.addSoftwareFallbacks()

	if len(caps.Encoders) == 0 {
		// Absolute fallback: at least libx264
		caps.Encoders = append(caps.Encoders, EncoderInfo{
			Codec:   CodecH264,
			Encoder: "libx264",
		})
		log.Printf("[HWAccel] Fallback to software-only: libx264")
	}

	return caps
}

// addSoftwareFallbacks ensures there is at least one software encoder per codec
// if hardware is not available for that codec.
func (caps *HWCapabilities) addSoftwareFallbacks() {
	hasCodec := make(map[Codec]bool)
	for _, enc := range caps.Encoders {
		hasCodec[enc.Codec] = true
	}

	for _, sw := range softwareEncoders {
		if !hasCodec[sw.Codec] {
			if testSoftwareEncoder(sw.Encoder) {
				caps.Encoders = append(caps.Encoders, EncoderInfo{
					Codec:   sw.Codec,
					Encoder: sw.Encoder,
				})
				log.Printf("[HWAccel] Software encoder available: %s", sw.Encoder)
			}
		}
	}
}

// findVAAPIDevice looks for a VAAPI render node under /dev/dri/.
func findVAAPIDevice() string {
	// Try common render nodes
	candidates := []string{
		"/dev/dri/renderD128",
		"/dev/dri/renderD129",
	}
	for _, dev := range candidates {
		if _, err := os.Stat(dev); err == nil {
			return dev
		}
	}
	return ""
}

// testVAAPIEncoder runs a quick encode test to verify a VAAPI encoder works.
func testVAAPIEncoder(device, encoder string) bool {
	cmd := exec.Command("ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-init_hw_device", fmt.Sprintf("vaapi=hw:%s", device),
		"-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1:r=1",
		"-vf", "format=nv12,hwupload",
		"-c:v", encoder,
		"-frames:v", "1",
		"-f", "null", "-",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[HWAccel] Test %s failed: %v %s", encoder, err, strings.TrimSpace(string(output)))
		return false
	}
	return true
}

// testVAAPIDecoder checks if VAAPI decoding is functional.
func testVAAPIDecoder(device string) bool {
	cmd := exec.Command("ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-hwaccel", "vaapi",
		"-hwaccel_device", device,
		"-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1:r=1",
		"-frames:v", "1",
		"-f", "null", "-",
	)
	err := cmd.Run()
	return err == nil
}

// testSoftwareEncoder checks if a software encoder is available in this FFmpeg build.
func testSoftwareEncoder(encoder string) bool {
	cmd := exec.Command("ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "nullsrc=s=256x256:d=0.1:r=1",
		"-c:v", encoder,
		"-frames:v", "1",
		"-f", "null", "-",
	)
	err := cmd.Run()
	return err == nil
}

// BrowserCodecs holds browser codec support flags (video + audio).
type BrowserCodecs struct {
	// Video
	H264 bool `json:"h264"`
	HEVC bool `json:"hevc"`
	AV1  bool `json:"av1"`
	VP9  bool `json:"vp9"`
	// Audio
	AAC  bool `json:"aac"`
	Opus bool `json:"opus"`
	FLAC bool `json:"flac"`
	AC3  bool `json:"ac3"`
}

// CanBrowserPlayAudio checks if the browser can play the given audio codec natively.
func CanBrowserPlayAudio(audioCodec string, browser BrowserCodecs) bool {
	normalized := NormalizeAudioCodecName(audioCodec)
	switch normalized {
	case "aac":
		return browser.AAC
	case "opus":
		return browser.Opus
	case "flac":
		// FLAC cannot be reliably streamed via HLS (fMP4/mpegts segments).
		// Even if the browser reports FLAC support, MSE/HLS.js may not handle
		// FLAC inside fragmented MP4. Always transcode to AAC for streaming.
		return false
	case "ac3":
		return browser.AC3
	case "mp3":
		return true // MP3 is universally supported
	default:
		// Unknown audio codecs (DTS, TrueHD, PCM, etc): assume not supported
		return false
	}
}

// NormalizeAudioCodecName maps FFprobe audio codec names to standard names.
// (Moved here from preset.go for shared use)
func NormalizeAudioCodecName(ffprobeCodec string) string {
	switch strings.ToLower(ffprobeCodec) {
	case "aac", "mp4a":
		return "aac"
	case "opus":
		return "opus"
	case "flac":
		return "flac"
	case "mp3", "mp3float":
		return "mp3"
	case "ac3", "eac3":
		return "ac3"
	case "dts", "dts-hd", "truehd":
		return "dts"
	case "vorbis":
		return "vorbis"
	case "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le":
		return "pcm"
	default:
		return strings.ToLower(ffprobeCodec)
	}
}

// NegotiateCodec picks the best codec from the intersection of
// server encoders and browser support.
// Priority: av1 > hevc > vp9 > h264.
func NegotiateCodec(caps *HWCapabilities, browser BrowserCodecs) *EncoderInfo {
	if caps == nil {
		return &EncoderInfo{Codec: CodecH264, Encoder: "libx264"}
	}

	// Priority order: av1 > hevc > vp9 > h264
	priority := []struct {
		codec   Codec
		browser bool
	}{
		{CodecAV1, browser.AV1},
		{CodecHEVC, browser.HEVC},
		{CodecVP9, browser.VP9},
		{CodecH264, browser.H264},
	}

	for _, p := range priority {
		if !p.browser {
			continue
		}
		for i := range caps.Encoders {
			if caps.Encoders[i].Codec == p.codec {
				return &caps.Encoders[i]
			}
		}
	}

	// Absolute fallback
	return &EncoderInfo{Codec: CodecH264, Encoder: "libx264"}
}

// GetEncoderForCodec returns the best available encoder for a specific codec.
func GetEncoderForCodec(caps *HWCapabilities, codec Codec) *EncoderInfo {
	if caps == nil {
		return &EncoderInfo{Codec: CodecH264, Encoder: "libx264"}
	}
	for i := range caps.Encoders {
		if caps.Encoders[i].Codec == codec {
			return &caps.Encoders[i]
		}
	}
	return &EncoderInfo{Codec: CodecH264, Encoder: "libx264"}
}

// NormalizeCodecName maps FFprobe codec names to standard codec names.
func NormalizeCodecName(ffprobeCodec string) string {
	switch strings.ToLower(ffprobeCodec) {
	case "h264", "avc", "avc1":
		return "h264"
	case "hevc", "h265", "hev1", "hvc1":
		return "hevc"
	case "av1", "av01":
		return "av1"
	case "vp9", "vp09":
		return "vp9"
	case "mpeg4", "mp4v":
		return "mpeg4"
	default:
		return strings.ToLower(ffprobeCodec)
	}
}
