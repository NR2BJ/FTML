package ffmpeg

import (
	"os"
	"os/exec"
	"path/filepath"
)

func GenerateThumbnail(inputPath, outputDir string) (string, error) {
	os.MkdirAll(outputDir, 0755)
	outputPath := filepath.Join(outputDir, "thumb.jpg")

	if _, err := os.Stat(outputPath); err == nil {
		return outputPath, nil
	}

	cmd := exec.Command("ffmpeg",
		"-i", inputPath,
		"-ss", "00:00:05",
		"-vframes", "1",
		"-vf", "scale=320:-1",
		"-y",
		outputPath,
	)

	if err := cmd.Run(); err != nil {
		return "", err
	}
	return outputPath, nil
}
