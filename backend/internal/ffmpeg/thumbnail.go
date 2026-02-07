package ffmpeg

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

// GenerateThumbnail creates a thumbnail for a video file.
// Uses VAAPI hardware decode when available for faster extraction.
// Seeks to 10% of the video duration for a more representative frame.
func GenerateThumbnail(inputPath, outputDir string) (string, error) {
	os.MkdirAll(outputDir, 0755)
	outputPath := filepath.Join(outputDir, "thumb.jpg")

	// Return cached thumbnail if it exists
	if _, err := os.Stat(outputPath); err == nil {
		return outputPath, nil
	}

	// Probe duration to seek to 10% of the video
	seekTime := "5" // fallback: 5 seconds
	info, err := Probe(inputPath)
	if err == nil && info.Duration != "" {
		var dur float64
		fmt.Sscanf(info.Duration, "%f", &dur)
		if dur > 0 {
			seekTo := dur * 0.10
			// Clamp: at least 1s, at most 5 minutes
			if seekTo < 1 {
				seekTo = 1
			}
			if seekTo > 300 {
				seekTo = 300
			}
			seekTime = fmt.Sprintf("%.2f", seekTo)
		}
	}

	// Try VAAPI hardware-accelerated decode first
	caps := GetCapabilities()
	if caps != nil && caps.CanDecode && caps.Device != "" {
		err := generateThumbnailVAAPI(inputPath, outputPath, seekTime, caps.Device)
		if err == nil {
			return outputPath, nil
		}
		log.Printf("[Thumbnail] VAAPI decode failed, falling back to CPU: %v", err)
	}

	// Fallback: CPU-only decode
	err = generateThumbnailCPU(inputPath, outputPath, seekTime)
	if err != nil {
		return "", err
	}
	return outputPath, nil
}

// generateThumbnailVAAPI extracts a thumbnail using VAAPI hardware decode.
func generateThumbnailVAAPI(inputPath, outputPath, seekTime, device string) error {
	cmd := exec.Command("ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-hwaccel", "vaapi",
		"-hwaccel_device", device,
		"-hwaccel_output_format", "vaapi",
		"-ss", seekTime,
		"-i", inputPath,
		"-vframes", "1",
		"-vf", "hwdownload,format=nv12,scale=320:-1",
		"-y",
		outputPath,
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, string(output))
	}
	return nil
}

// generateThumbnailCPU extracts a thumbnail using CPU decode only.
func generateThumbnailCPU(inputPath, outputPath, seekTime string) error {
	cmd := exec.Command("ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-ss", seekTime,
		"-i", inputPath,
		"-vframes", "1",
		"-vf", "scale=320:-1",
		"-y",
		outputPath,
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, string(output))
	}
	return nil
}
