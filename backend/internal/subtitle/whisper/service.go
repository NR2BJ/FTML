package whisper

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/video-stream/backend/internal/job"
)

// Service manages whisper transcription engines and processes jobs
type Service struct {
	engines      map[string]Transcriber
	mediaPath    string
	subtitlePath string
}

// NewService creates a whisper service with available engines
func NewService(mediaPath, subtitlePath, whisperURL, openAIKey string) *Service {
	s := &Service{
		engines:      make(map[string]Transcriber),
		mediaPath:    mediaPath,
		subtitlePath: subtitlePath,
	}

	// Register whisper.cpp engine (always available if URL configured)
	if whisperURL != "" {
		s.engines["whisper.cpp"] = NewWhisperCppClient(whisperURL)
		log.Printf("[whisper] registered whisper.cpp engine at %s", whisperURL)
	}

	// Register OpenAI Whisper engine
	if openAIKey != "" {
		s.engines["openai"] = NewOpenAIWhisperClient(openAIKey)
		log.Printf("[whisper] registered OpenAI Whisper engine")
	}

	return s
}

// RegisterEngine adds an engine (e.g., faster-whisper)
func (s *Service) RegisterEngine(name string, engine Transcriber) {
	s.engines[name] = engine
	log.Printf("[whisper] registered %s engine", name)
}

// HandleJob processes a transcription job
func (s *Service) HandleJob(ctx context.Context, j *job.Job, updateProgress func(float64)) error {
	var params job.TranscribeParams
	if err := json.Unmarshal(j.Params, &params); err != nil {
		return fmt.Errorf("unmarshal params: %w", err)
	}

	engine, ok := s.engines[params.Engine]
	if !ok {
		return fmt.Errorf("unknown whisper engine: %s (available: %v)", params.Engine, s.engineNames())
	}

	// Resolve full path
	fullPath := filepath.Join(s.mediaPath, j.FilePath)
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		return fmt.Errorf("file not found: %s", j.FilePath)
	}

	log.Printf("[whisper] starting transcription: engine=%s file=%s language=%s",
		params.Engine, j.FilePath, params.Language)

	result, err := engine.Transcribe(ctx, TranscribeRequest{
		FilePath: fullPath,
		Language: params.Language,
		Model:    params.Model,
	}, updateProgress)
	if err != nil {
		return fmt.Errorf("transcribe: %w", err)
	}

	// Save VTT to subtitle output directory
	hash := videoHash(j.FilePath)
	outDir := filepath.Join(s.subtitlePath, hash)
	os.MkdirAll(outDir, 0755)

	lang := result.Language
	if lang == "" || lang == "auto" {
		lang = "auto"
	}
	outFile := filepath.Join(outDir, fmt.Sprintf("whisper_%s.vtt", lang))

	if err := os.WriteFile(outFile, []byte(result.VTT), 0644); err != nil {
		return fmt.Errorf("save subtitle: %w", err)
	}

	log.Printf("[whisper] transcription complete: %s", outFile)

	// Store result in job
	resultJSON, _ := json.Marshal(job.TranscribeResult{
		OutputPath: fmt.Sprintf("generated:whisper_%s.vtt", lang),
		Language:   lang,
	})
	j.Result = resultJSON

	updateProgress(1.0)
	return nil
}

func (s *Service) engineNames() []string {
	names := make([]string, 0, len(s.engines))
	for name := range s.engines {
		names = append(names, name)
	}
	return names
}

func videoHash(videoPath string) string {
	h := sha256.Sum256([]byte(videoPath))
	return fmt.Sprintf("%x", h[:8])
}
