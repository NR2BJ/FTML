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
}

// QualityOption is returned to the frontend for the quality selector.
type QualityOption struct {
	Value      string `json:"value"`       // "720p", "1080p", "original"
	Label      string `json:"label"`       // "720p", "1080p", "Original"
	Desc       string `json:"desc"`        // "~8 Mbps", "Direct play"
	Height     int    `json:"height"`
	CRF        int    `json:"crf"`
	MaxBitrate string `json:"max_bitrate"`
	BufSize    string `json:"buf_size"`
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

// CRF values per resolution for near-visually-lossless h264 quality.
// Lower CRF = higher quality. These are generous for a personal server.
var crfForHeight = map[int]int{
	720:  17,
	1080: 16,
	1440: 15,
	2160: 15,
}

// GeneratePresets creates quality options based on the source video's properties.
// It returns transcode tiers from 720p up to (but not exceeding) the source resolution,
// plus an "original" direct play option.
func GeneratePresets(info *MediaInfo) []QualityOption {
	if info == nil {
		return defaultPresets()
	}

	srcHeight := info.Height
	if srcHeight <= 0 {
		return defaultPresets()
	}

	// Parse source bitrate (format-level, in bps)
	srcBitrate := parseBitrate(info.BitRate)
	if srcBitrate <= 0 {
		// Estimate from file size and duration if available
		srcBitrate = estimateBitrate(info)
	}

	var options []QualityOption

	for _, tier := range resolutionTiers {
		// Only include tiers that are strictly less than source height
		// (we don't transcode to the same resolution - that's what original is for)
		if tier.Height >= srcHeight {
			continue
		}

		crf := crfForHeight[tier.Height]
		maxBitrate := computeMaxBitrate(srcBitrate, srcHeight, tier.Height)
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
		})
	}

	// If source is >= 1080p, also offer a "same resolution" transcode option
	// (useful when source codec isn't browser-compatible)
	if srcHeight >= 720 {
		srcTierLabel := findClosestTierLabel(srcHeight)
		crf := crfForHeight[findClosestTierHeight(srcHeight)]
		maxBitrate := computeMaxBitrate(srcBitrate, srcHeight, srcHeight)
		maxBitrateStr := formatBitrateM(maxBitrate)
		bufSize := formatBitrateM(maxBitrate * 2)

		options = append(options, QualityOption{
			Value:      strings.ToLower(srcTierLabel),
			Label:      srcTierLabel,
			Desc:       fmt.Sprintf("~%s", formatBitrateHuman(maxBitrate)),
			Height:     srcHeight,
			CRF:        crf,
			MaxBitrate: maxBitrateStr,
			BufSize:    bufSize,
		})
	}

	// Always add original direct play
	srcBitrateDesc := "Direct play"
	if srcBitrate > 0 {
		srcBitrateDesc = fmt.Sprintf("%s direct", formatBitrateHuman(srcBitrate))
	}
	options = append(options, QualityOption{
		Value: "original",
		Label: "Original",
		Desc:  srcBitrateDesc,
	})

	return options
}

// computeMaxBitrate calculates maxrate for a target resolution.
// The approach: scale source bitrate by area ratio, then apply a generous 1.5x headroom
// factor to account for h264 re-encoding overhead at near-lossless CRF.
// The result is capped to not exceed 95% of source bitrate.
func computeMaxBitrate(srcBitrate float64, srcHeight, targetHeight int) float64 {
	if srcBitrate <= 0 || srcHeight <= 0 {
		// Fallback defaults
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

	// For same-resolution transcode (hevc→h264), h264 typically needs ~1.5x the bitrate
	// of a well-encoded hevc to maintain similar visual quality.
	// Apply a generous 1.5x factor for all cases to ensure headroom.
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
// given the computed preset list. Returns nil if quality is "original" or not found.
func GetTranscodeParams(quality string, presets []QualityOption) *TranscodeParams {
	if quality == "original" {
		return nil
	}
	for _, p := range presets {
		if p.Value == quality {
			return &TranscodeParams{
				Label:      p.Label,
				Height:     p.Height,
				CRF:        p.CRF,
				MaxBitrate: p.MaxBitrate,
				BufSize:    p.BufSize,
			}
		}
	}
	return nil
}

// defaultPresets returns fallback presets when FFprobe data is unavailable.
func defaultPresets() []QualityOption {
	return []QualityOption{
		{Value: "720p", Label: "720p", Desc: "~10 Mbps", Height: 720, CRF: 17, MaxBitrate: "10M", BufSize: "20M"},
		{Value: "1080p", Label: "1080p", Desc: "~20 Mbps", Height: 1080, CRF: 16, MaxBitrate: "20M", BufSize: "40M"},
		{Value: "original", Label: "Original", Desc: "Direct play"},
	}
}
