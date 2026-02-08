package whisper

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/job"
)

// Service manages whisper transcription engines and processes jobs
type Service struct {
	database     *db.Database
	mediaPath    string
	subtitlePath string
}

// NewService creates a whisper service backed by database-registered backends
func NewService(mediaPath, subtitlePath string, database *db.Database) *Service {
	return &Service{
		database:     database,
		mediaPath:    mediaPath,
		subtitlePath: subtitlePath,
	}
}

// resolveEngine dynamically resolves a whisper engine from the database
func (s *Service) resolveEngine(engineKey string) (Transcriber, error) {
	// Handle "backend:<id>" format (new dynamic backends)
	if strings.HasPrefix(engineKey, "backend:") {
		idStr := strings.TrimPrefix(engineKey, "backend:")
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid backend id: %s", idStr)
		}
		backend, err := s.database.GetWhisperBackend(id)
		if err != nil {
			return nil, fmt.Errorf("backend not found: %d", id)
		}
		if !backend.Enabled {
			return nil, fmt.Errorf("backend %q is disabled", backend.Name)
		}
		if backend.BackendType == "openai" {
			key := s.database.GetSetting("openai_api_key", "")
			if key == "" {
				return nil, fmt.Errorf("OpenAI API key not configured")
			}
			return NewOpenAIWhisperClient(key), nil
		}
		return NewWhisperCppClient(backend.URL), nil
	}

	// Legacy: "openai" → use OpenAI API key from settings
	if engineKey == "openai" {
		key := s.database.GetSetting("openai_api_key", "")
		if key == "" {
			return nil, fmt.Errorf("OpenAI API key not configured")
		}
		return NewOpenAIWhisperClient(key), nil
	}

	// Legacy: "whisper.cpp" → first enabled local backend
	if engineKey == "whisper.cpp" {
		backends, err := s.database.ListWhisperBackends()
		if err != nil {
			return nil, fmt.Errorf("list backends: %w", err)
		}
		for _, b := range backends {
			if b.Enabled && b.BackendType != "openai" {
				return NewWhisperCppClient(b.URL), nil
			}
		}
		return nil, fmt.Errorf("no local whisper backend configured")
	}

	return nil, fmt.Errorf("unknown engine: %s", engineKey)
}

// HandleJob processes a transcription job
func (s *Service) HandleJob(ctx context.Context, j *job.Job, updateProgress func(float64)) error {
	var params job.TranscribeParams
	if err := json.Unmarshal(j.Params, &params); err != nil {
		return fmt.Errorf("unmarshal params: %w", err)
	}

	engine, err := s.resolveEngine(params.Engine)
	if err != nil {
		return fmt.Errorf("resolve engine: %w", err)
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

func videoHash(videoPath string) string {
	h := sha256.Sum256([]byte(videoPath))
	return fmt.Sprintf("%x", h[:8])
}
