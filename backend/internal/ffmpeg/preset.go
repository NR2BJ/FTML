package ffmpeg

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// TranscodeParams holds the computed transcode parameters for a specific quality level.
type TranscodeParams struct {
	Label      string `json:"label"`       // e.g. "720p", "1080p"
	Height     int    `json:"height"`      // target height (0 = original)
	CRF        int    `json:"crf"`
	MaxBitrate string `json:"max_bitrate"` // e.g. "12M"
	BufSize    string `json:"buf_size"`    // e.g. "24M"
	// Codec fields (Phase 3)
	VideoCodec       string `json:"video_codec"`        // "h264", "hevc", "av1", "vp9", or "copy" for passthrough
	AudioCodec       string `json:"audio_codec"`        // "aac" or "opus"
	Encoder          string `json:"encoder"`            // "h264_vaapi", "libx264", "copy", etc.
	HWAccel          string `json:"hwaccel"`            // "vaapi" or ""
	Device           string `json:"device"`             // "/dev/dri/renderD128" or ""
	SegmentFmt       string `json:"segment_fmt"`        // "mpegts" or "fmp4"
	AudioStreamIndex int    `json:"audio_stream_index"` // which audio stream to use (0-based, audio-only index)
	SourceVideoCodec string `json:"source_video_codec"` // for passthrough: normalized source codec ("hevc", "h264", etc.)
	SourceAudioCodec string `json:"source_audio_codec"` // for passthrough: normalized source audio codec ("aac", "dts", etc.)
}

// QualityOption is returned to the frontend for the quality selector.
type QualityOption struct {
	Value            string `json:"value"`                            // "720p", "1080p", "original", "passthrough"
	Label            string `json:"label"`                            // "720p", "1080p", "Original"
	Desc             string `json:"desc"`                             // "~8 Mbps", "Direct play"
	Height           int    `json:"height"`
	CRF              int    `json:"crf"`
	MaxBitrate       string `json:"max_bitrate"`
	BufSize          string `json:"buf_size"`
	VideoCodec       string `json:"video_codec"`                     // "h264", "hevc", "av1"
	AudioCodec       string `json:"audio_codec"`                     // "aac", "opus"
	CanOriginal      bool   `json:"can_original,omitempty"`          // Whether browser can play full original (video+audio)
	CanOriginalVideo bool   `json:"can_original_video,omitempty"`    // Whether browser can play original video codec
	CanOriginalAudio bool   `json:"can_original_audio,omitempty"`    // Whether browser can play original audio codec
	SourceAudioCodec string `json:"-"`                               // internal: source audio codec for passthrough copy decision
}

// Standard resolution tiers
var resolutionTiers = []struct {
	Height int
	Label  string
}{
	{720, "720p"},
	{1080, "1080p"},
	{1440, "1440p"},
	{2160, "4K"},
}

// CRF/QP values per codec per resolution for near-visually-lossless quality.
// h264: CRF scale (lower=better), hevc: CRF scale, av1: QP for VAAPI, vp9: CRF scale
var codecCRF = map[Codec]map[int]int{
	CodecH264: {720: 17, 1080: 16, 1440: 15, 2160: 15},
	CodecHEVC: {720: 22, 1080: 21, 1440: 20, 2160: 20},
	CodecAV1:  {720: 30, 1080: 28, 1440: 27, 2160: 27},
	CodecVP9:  {720: 25, 1080: 23, 1440: 22, 2160: 22},
}

// Audio codec pairing per video codec.
// Using AAC for all codecs: universally supported, reliable in all containers,
// and avoids libopus initialization issues in FFmpeg.
var codecAudio = map[Codec]string{
	CodecH264: "aac",
	CodecHEVC: "aac",
	CodecAV1:  "aac",
	CodecVP9:  "aac",
}

// HLS segment format per codec.
// h264 → mpegts (.ts), hevc/av1/vp9 → fmp4 (.m4s)
var codecSegmentFmt = map[Codec]string{
	CodecH264: "mpegts",
	CodecHEVC: "fmp4",
	CodecAV1:  "fmp4",
	CodecVP9:  "fmp4",
}

// GetSegmentFmt returns the HLS segment format for a given normalized video codec.
func GetSegmentFmt(videoCodec string) string {
	segFmt := codecSegmentFmt[Codec(videoCodec)]
	if segFmt == "" {
		return "mpegts"
	}
	return segFmt
}

// Bitrate efficiency relative to h264.
// A codec with ratio 0.65 needs only 65% of h264's bitrate for similar quality.
var codecBitrateRatio = map[Codec]float64{
	CodecH264: 1.0,
	CodecHEVC: 0.65,
	CodecAV1:  0.50,
	CodecVP9:  0.65,
}

// GeneratePresets creates quality options based on the source video's properties
// and the negotiated codec.
func GeneratePresets(info *MediaInfo, codec Codec, encoder *EncoderInfo, browser BrowserCodecs) []QualityOption {
	if info == nil {
		return defaultPresets(codec, encoder)
	}

	srcHeight := info.Height
	if srcHeight <= 0 {
		return defaultPresets(codec, encoder)
	}

	// Parse source bitrate (format-level, in bps)
	srcBitrate := parseBitrate(info.BitRate)
	if srcBitrate <= 0 {
		srcBitrate = estimateBitrate(info)
	}

	crfMap := codecCRF[codec]
	if crfMap == nil {
		crfMap = codecCRF[CodecH264]
	}
	bitrateRatio := codecBitrateRatio[codec]
	if bitrateRatio <= 0 {
		bitrateRatio = 1.0
	}
	audioCodec := codecAudio[codec]
	if audioCodec == "" {
		audioCodec = "aac"
	}
	segFmt := codecSegmentFmt[codec]
	if segFmt == "" {
		segFmt = "mpegts"
	}

	var options []QualityOption

	for _, tier := range resolutionTiers {
		if tier.Height >= srcHeight {
			continue
		}

		crf := crfMap[tier.Height]
		if crf == 0 {
			crf = crfMap[findClosestTierHeight(tier.Height)]
		}
		// Scale bitrate by codec efficiency
		maxBitrate := computeMaxBitrate(srcBitrate, srcHeight, tier.Height) * bitrateRatio
		maxBitrateStr := formatBitrateM(maxBitrate)
		bufSize := formatBitrateM(maxBitrate * 2)

		options = append(options, QualityOption{
			Value:      strings.ToLower(tier.Label),
			Label:      tier.Label,
			Desc:       fmt.Sprintf("~%s", formatBitrateHuman(maxBitrate)),
			Height:     tier.Height,
			CRF:        crf,
			MaxBitrate: maxBitrateStr,
			BufSize:    bufSize,
			VideoCodec: string(codec),
			AudioCodec: audioCodec,
		})
	}

	// Same-resolution transcode option (useful when source codec isn't browser-compatible)
	// Uses actual source height (e.g. "1608p") instead of closest tier to avoid
	// dedup collision when the source height doesn't match a standard tier exactly.
	if srcHeight >= 720 {
		// Use standard tier label if exact match (e.g. 1440→"1440p", 2160→"4K"),
		// otherwise use actual height (e.g. 1608→"1608p")
		srcLabel := fmt.Sprintf("%dp", srcHeight)
		for _, tier := range resolutionTiers {
			if tier.Height == srcHeight {
				srcLabel = tier.Label
				break
			}
		}
		srcValue := strings.ToLower(srcLabel)

		// Only add if not already present from Phase 1
		alreadyExists := false
		for _, opt := range options {
			if opt.Value == srcValue {
				alreadyExists = true
				break
			}
		}
		if !alreadyExists {
			crf := crfMap[findClosestTierHeight(srcHeight)]
			maxBitrate := computeMaxBitrate(srcBitrate, srcHeight, srcHeight) * bitrateRatio
			maxBitrateStr := formatBitrateM(maxBitrate)
			bufSize := formatBitrateM(maxBitrate * 2)

			options = append(options, QualityOption{
				Value:      srcValue,
				Label:      srcLabel,
				Desc:       fmt.Sprintf("~%s", formatBitrateHuman(maxBitrate)),
				Height:     srcHeight,
				CRF:        crf,
				MaxBitrate: maxBitrateStr,
				BufSize:    bufSize,
				VideoCodec: string(codec),
				AudioCodec: audioCodec,
			})
		}
	}

	// Original direct play: requires both codec AND container support.
	// MKV files can never be direct-played by browsers.
	canDirectPlayVideo := canBrowserDirectPlay(info.VideoCodec, info.Container, browser)
	canDirectPlayAudio := CanBrowserPlayAudio(info.AudioCodec, browser)
	canOriginal := canDirectPlayVideo && canDirectPlayAudio

	srcBitrateDesc := "Direct play"
	if srcBitrate > 0 {
		srcBitrateDesc = fmt.Sprintf("%s direct", formatBitrateHuman(srcBitrate))
	}
	options = append(options, QualityOption{
		Value:            "original",
		Label:            "Original",
		Desc:             srcBitrateDesc,
		CanOriginal:      canOriginal,
		CanOriginalVideo: canDirectPlayVideo,
		CanOriginalAudio: canDirectPlayAudio,
		VideoCodec:       NormalizeCodecName(info.VideoCodec),
		AudioCodec:       NormalizeAudioCodecName(info.AudioCodec),
	})

	// Passthrough option: video copy (+ audio transcode if needed) via HLS.
	// This only needs codec support (not container), because HLS remuxes into fmp4/mpegts.
	// Generated when:
	//  1. Browser can decode the video codec but audio is incompatible, OR
	//  2. Browser can decode both but container is incompatible (e.g. MKV HEVC)
	canDecodeVideo := canBrowserDecodeCodec(info.VideoCodec, browser)

	// 10bit H.264 is not decodable via MSE in any browser — disable passthrough
	if canDecodeVideo && NormalizeCodecName(info.VideoCodec) == "h264" && Is10bit(info.PixFmt) {
		canDecodeVideo = false
	}

	needsPassthrough := canDecodeVideo && (!canDirectPlayAudio || !canDirectPlayVideo)
	if needsPassthrough {
		// Determine the right segment format for the video codec
		videoCodecNorm := NormalizeCodecName(info.VideoCodec)
		ptSegFmt := codecSegmentFmt[Codec(videoCodecNorm)]
		if ptSegFmt == "" {
			ptSegFmt = "mpegts"
		}

		ptLabel := "Original (AAC)"
		ptDesc := "Video direct, audio AAC"
		if srcBitrate > 0 {
			ptDesc = fmt.Sprintf("%s video + AAC audio", formatBitrateHuman(srcBitrate))
		}
		// If audio is already compatible, this is a container remux, not audio conversion
		if canDirectPlayAudio {
			ptLabel = "Original (Remux)"
			ptDesc = "Video direct, remuxed"
			if srcBitrate > 0 {
				ptDesc = fmt.Sprintf("%s remuxed", formatBitrateHuman(srcBitrate))
			}
		}

		options = append(options, QualityOption{
			Value:            "passthrough",
			Label:            ptLabel,
			Desc:             ptDesc,
			CanOriginal:      false,
			CanOriginalVideo: true,
			CanOriginalAudio: canDirectPlayAudio,
			VideoCodec:       videoCodecNorm,
			AudioCodec:       "aac",
			SourceAudioCodec: NormalizeAudioCodecName(info.AudioCodec),
		})
	}

	return options
}

// canBrowserDecodeCodec checks if the browser can decode the given video codec.
// Used for passthrough (video copy via HLS) where the container is always fmp4/mpegts.
func canBrowserDecodeCodec(ffprobeCodec string, browser BrowserCodecs) bool {
	normalized := NormalizeCodecName(ffprobeCodec)
	switch normalized {
	case "h264":
		return browser.H264
	case "hevc":
		return browser.HEVC
	case "av1":
		return browser.AV1
	case "vp9":
		return browser.VP9
	default:
		return false
	}
}

// canBrowserDirectPlay checks if the browser can play the original file directly.
// This requires BOTH codec support AND a browser-compatible container (MP4, WebM).
// MKV, AVI, etc. can NEVER be direct-played regardless of codec support because
// browsers don't support these container formats in <video> elements.
func canBrowserDirectPlay(ffprobeCodec string, container string, browser BrowserCodecs) bool {
	// Container check: browsers can only direct-play MP4/MOV and WebM containers.
	if container != "" && container != "mp4" && container != "webm" {
		return false
	}
	return canBrowserDecodeCodec(ffprobeCodec, browser)
}

// computeMaxBitrate calculates maxrate for a target resolution.
// The approach: scale source bitrate by area ratio, then apply a generous 1.5x headroom
// factor to account for re-encoding overhead at near-lossless CRF.
// NOTE: This returns the h264-equivalent bitrate. Caller should multiply by codecBitrateRatio.
func computeMaxBitrate(srcBitrate float64, srcHeight, targetHeight int) float64 {
	if srcBitrate <= 0 || srcHeight <= 0 {
		// Fallback defaults (h264-equivalent)
		switch {
		case targetHeight <= 720:
			return 10_000_000
		case targetHeight <= 1080:
			return 20_000_000
		case targetHeight <= 1440:
			return 35_000_000
		default:
			return 50_000_000
		}
	}

	// Area-based scaling: bitrate scales roughly with pixel count
	areaRatio := float64(targetHeight*targetHeight) / float64(srcHeight*srcHeight)

	// Base estimate: source bitrate scaled by area ratio
	estimated := srcBitrate * areaRatio

	// Apply a generous 1.5x factor for re-encoding overhead
	estimated *= 1.5

	// Cap at 95% of source bitrate (transcoding shouldn't use more than source)
	maxCap := srcBitrate * 0.95
	if targetHeight >= srcHeight {
		// Same resolution: cap at source bitrate * 1.5 (codec overhead)
		maxCap = srcBitrate * 1.5
	}
	if estimated > maxCap {
		estimated = maxCap
	}

	// Floor values per resolution to ensure minimum usable quality
	floors := map[int]float64{
		720:  4_000_000,
		1080: 8_000_000,
		1440: 15_000_000,
		2160: 25_000_000,
	}
	floor := floors[findClosestTierHeight(targetHeight)]
	if floor > 0 && estimated < floor {
		estimated = floor
	}

	// Round to nearest 0.5M for cleaner numbers
	return math.Round(estimated/500_000) * 500_000
}

func findClosestTierLabel(height int) string {
	for i := len(resolutionTiers) - 1; i >= 0; i-- {
		if height >= resolutionTiers[i].Height {
			return resolutionTiers[i].Label
		}
	}
	return fmt.Sprintf("%dp", height)
}

func findClosestTierHeight(height int) int {
	closest := 1080 // default
	for _, tier := range resolutionTiers {
		if height >= tier.Height {
			closest = tier.Height
		}
	}
	return closest
}

func parseBitrate(s string) float64 {
	if s == "" {
		return 0
	}
	s = strings.TrimSpace(s)
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v // already in bps from ffprobe
}

func estimateBitrate(info *MediaInfo) float64 {
	if info.Size == "" || info.Duration == "" {
		return 0
	}
	size, err := strconv.ParseFloat(info.Size, 64)
	if err != nil || size <= 0 {
		return 0
	}
	dur, err := strconv.ParseFloat(info.Duration, 64)
	if err != nil || dur <= 0 {
		return 0
	}
	return (size * 8) / dur
}

func formatBitrateM(bps float64) string {
	mbps := bps / 1_000_000
	if mbps >= 1 {
		return fmt.Sprintf("%.0fM", math.Ceil(mbps))
	}
	return fmt.Sprintf("%.0fk", bps/1000)
}

func formatBitrateHuman(bps float64) string {
	mbps := bps / 1_000_000
	if mbps >= 1 {
		if mbps == math.Floor(mbps) {
			return fmt.Sprintf("%.0f Mbps", mbps)
		}
		return fmt.Sprintf("%.1f Mbps", mbps)
	}
	return fmt.Sprintf("%.0f kbps", bps/1000)
}

// GetTranscodeParams resolves a quality value (e.g. "720p") to TranscodeParams,
// given the computed preset list and the encoder info. Returns nil if quality is "original".
func GetTranscodeParams(quality string, presets []QualityOption, encoder *EncoderInfo) *TranscodeParams {
	if quality == "original" {
		return nil
	}

	// Passthrough: video copy + audio transcode
	// Always use fmp4 for passthrough regardless of codec.
	// MKV→mpegts remux causes DTS/timestamp issues that break playback,
	// while fmp4 handles negative DTS gracefully via init segment + moof/mdat.
	if quality == "passthrough" {
		for _, p := range presets {
			if p.Value == "passthrough" {
				return &TranscodeParams{
					Label:            p.Label,
					VideoCodec:       "copy",
					AudioCodec:       "aac",
					Encoder:          "copy",
					SegmentFmt:       "fmp4",
					SourceVideoCodec: p.VideoCodec,
					SourceAudioCodec: p.SourceAudioCodec,
				}
			}
		}
		return nil
	}

	for _, p := range presets {
		if p.Value == quality && p.Value != "original" {
			hwaccel := ""
			device := ""
			if encoder != nil {
				hwaccel = encoder.HWAccel
				device = encoder.Device
			}
			encoderName := "libx264"
			if encoder != nil {
				encoderName = encoder.Encoder
			}

			return &TranscodeParams{
				Label:      p.Label,
				Height:     p.Height,
				CRF:        p.CRF,
				MaxBitrate: p.MaxBitrate,
				BufSize:    p.BufSize,
				VideoCodec: p.VideoCodec,
				AudioCodec: p.AudioCodec,
				Encoder:    encoderName,
				HWAccel:    hwaccel,
				Device:     device,
				SegmentFmt: codecSegmentFmt[Codec(p.VideoCodec)],
			}
		}
	}
	return nil
}

// Is10bit returns true if the pixel format indicates 10-bit or higher depth.
// Common 10bit formats: yuv420p10le, yuv422p10le, yuv444p10le, p010le, etc.
func Is10bit(pixFmt string) bool {
	return strings.Contains(pixFmt, "10le") || strings.Contains(pixFmt, "10be") ||
		strings.Contains(pixFmt, "10p") || strings.Contains(pixFmt, "p010")
}

// defaultPresets returns fallback presets when FFprobe data is unavailable.
func defaultPresets(codec Codec, encoder *EncoderInfo) []QualityOption {
	crfMap := codecCRF[codec]
	if crfMap == nil {
		crfMap = codecCRF[CodecH264]
	}
	bitrateRatio := codecBitrateRatio[codec]
	if bitrateRatio <= 0 {
		bitrateRatio = 1.0
	}
	audioCodec := codecAudio[codec]
	if audioCodec == "" {
		audioCodec = "aac"
	}

	br720 := 10_000_000.0 * bitrateRatio
	br1080 := 20_000_000.0 * bitrateRatio

	return []QualityOption{
		{
			Value: "720p", Label: "720p",
			Desc:       fmt.Sprintf("~%s", formatBitrateHuman(br720)),
			Height:     720, CRF: crfMap[720],
			MaxBitrate: formatBitrateM(br720), BufSize: formatBitrateM(br720 * 2),
			VideoCodec: string(codec), AudioCodec: audioCodec,
		},
		{
			Value: "1080p", Label: "1080p",
			Desc:       fmt.Sprintf("~%s", formatBitrateHuman(br1080)),
			Height:     1080, CRF: crfMap[1080],
			MaxBitrate: formatBitrateM(br1080), BufSize: formatBitrateM(br1080 * 2),
			VideoCodec: string(codec), AudioCodec: audioCodec,
		},
		{Value: "original", Label: "Original", Desc: "Direct play", CanOriginal: true},
	}
}
