package translate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/video-stream/backend/internal/job"
)

// Service manages translation engines and processes translation jobs
type Service struct {
	engines      map[string]Translator
	mediaPath    string
	subtitlePath string
}

// NewService creates a translation service with available engines
func NewService(mediaPath, subtitlePath, geminiKey string, geminiModelResolver ModelResolver, openAIKey, deeplKey string) *Service {
	s := &Service{
		engines:      make(map[string]Translator),
		mediaPath:    mediaPath,
		subtitlePath: subtitlePath,
	}

	if geminiKey != "" {
		s.engines["gemini"] = NewGeminiTranslator(geminiKey, geminiModelResolver)
		log.Printf("[translate] registered Gemini engine (model resolved dynamically from DB)")
	}

	if openAIKey != "" {
		s.engines["openai"] = NewOpenAITranslator(openAIKey)
		log.Printf("[translate] registered OpenAI translation engine")
	}

	if deeplKey != "" {
		s.engines["deepl"] = NewDeepLTranslator(deeplKey)
		log.Printf("[translate] registered DeepL translation engine")
	}

	return s
}

// HandleJob processes a translation job
func (s *Service) HandleJob(ctx context.Context, j *job.Job, updateProgress func(float64)) error {
	var params job.TranslateParams
	if err := json.Unmarshal(j.Params, &params); err != nil {
		return fmt.Errorf("unmarshal params: %w", err)
	}

	engine, ok := s.engines[params.Engine]
	if !ok {
		return fmt.Errorf("unknown translation engine: %s", params.Engine)
	}

	// Load source subtitle
	vttContent, err := s.loadSubtitle(j.FilePath, params.SubtitleID)
	if err != nil {
		return fmt.Errorf("load subtitle: %w", err)
	}

	// Parse VTT
	cues := ParseVTT(vttContent)
	if len(cues) == 0 {
		return fmt.Errorf("no subtitle cues found in source")
	}

	log.Printf("[translate] translating %d cues: engine=%s target=%s preset=%s",
		len(cues), params.Engine, params.TargetLang, params.Preset)

	// Detect source language from subtitle ID (e.g., "generated:whisper_ja.vtt" → "ja")
	sourceLang := detectSourceLang(params.SubtitleID)

	// Translate
	translated, err := engine.Translate(ctx, cues, TranslateOptions{
		SourceLang:   sourceLang,
		TargetLang:   params.TargetLang,
		Preset:       params.Preset,
		CustomPrompt: params.CustomPrompt,
	}, updateProgress)
	if err != nil {
		return fmt.Errorf("translate: %w", err)
	}

	// Save translated VTT
	hash := videoHash(j.FilePath)
	outDir := filepath.Join(s.subtitlePath, hash)
	os.MkdirAll(outDir, 0755)

	outFile := filepath.Join(outDir, fmt.Sprintf("translate_%s_%s.vtt", params.TargetLang, params.Engine))
	vtt := CuesToVTT(translated)

	if err := os.WriteFile(outFile, []byte(vtt), 0644); err != nil {
		return fmt.Errorf("save translated subtitle: %w", err)
	}

	log.Printf("[translate] translation complete: %s", outFile)

	// Store result in job
	resultJSON, _ := json.Marshal(job.TranslateResult{
		OutputPath: fmt.Sprintf("generated:translate_%s_%s.vtt", params.TargetLang, params.Engine),
	})
	j.Result = resultJSON

	updateProgress(1.0)
	return nil
}

// loadSubtitle reads subtitle content from the appropriate source
func (s *Service) loadSubtitle(videoPath, subtitleID string) (string, error) {
	if strings.HasPrefix(subtitleID, "generated:") {
		// Load from generated subtitles directory
		filename := strings.TrimPrefix(subtitleID, "generated:")
		hash := videoHash(videoPath)
		subPath := filepath.Join(s.subtitlePath, hash, filename)
		data, err := os.ReadFile(subPath)
		if err != nil {
			return "", fmt.Errorf("read generated subtitle: %w", err)
		}
		return string(data), nil
	}

	if strings.HasPrefix(subtitleID, "external:") {
		// Load from media directory
		filename := strings.TrimPrefix(subtitleID, "external:")
		fullPath := filepath.Join(s.mediaPath, videoPath)
		videoDir := filepath.Dir(fullPath)
		subPath := filepath.Join(videoDir, filename)
		data, err := os.ReadFile(subPath)
		if err != nil {
			return "", fmt.Errorf("read external subtitle: %w", err)
		}
		// Convert SRT to VTT if needed
		if strings.HasSuffix(strings.ToLower(filename), ".srt") {
			return srtToVTTString(string(data)), nil
		}
		return string(data), nil
	}

	if strings.HasPrefix(subtitleID, "embedded:") {
		// Extract embedded subtitle via FFmpeg as VTT
		var streamIndex int
		fmt.Sscanf(strings.TrimPrefix(subtitleID, "embedded:"), "%d", &streamIndex)

		fullPath := filepath.Join(s.mediaPath, videoPath)
		cmd := exec.Command("ffmpeg",
			"-hide_banner",
			"-loglevel", "error",
			"-i", fullPath,
			"-map", fmt.Sprintf("0:%d", streamIndex),
			"-f", "webvtt",
			"pipe:1",
		)

		output, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("extract embedded subtitle (stream %d): %w", streamIndex, err)
		}
		return string(output), nil
	}

	return "", fmt.Errorf("unknown subtitle type: %s", subtitleID)
}

func detectSourceLang(subtitleID string) string {
	// "generated:whisper_ja.vtt" → "ja"
	// "generated:translate_ko_gemini.vtt" → "ko"
	// "external:video.en.srt" → "en"
	name := subtitleID
	for _, prefix := range []string{"generated:", "external:"} {
		name = strings.TrimPrefix(name, prefix)
	}
	name = strings.TrimSuffix(name, filepath.Ext(name))

	if strings.HasPrefix(name, "whisper_") {
		return strings.TrimPrefix(name, "whisper_")
	}
	if strings.HasPrefix(name, "translate_") {
		parts := strings.SplitN(strings.TrimPrefix(name, "translate_"), "_", 2)
		if len(parts) >= 1 {
			return parts[0]
		}
	}

	// Try to extract from "video.en" pattern
	parts := strings.Split(name, ".")
	if len(parts) >= 2 {
		lang := parts[len(parts)-1]
		if len(lang) == 2 || len(lang) == 3 {
			return lang
		}
	}

	return "auto"
}

func srtToVTTString(srt string) string {
	vtt := "WEBVTT\n\n"
	srt = strings.ReplaceAll(srt, "\r\n", "\n")
	// Replace timestamp commas with dots
	srt = strings.ReplaceAll(srt, ",", ".")
	vtt += srt
	return vtt
}

func videoHash(videoPath string) string {
	h := sha256.Sum256([]byte(videoPath))
	return fmt.Sprintf("%x", h[:8])
}
