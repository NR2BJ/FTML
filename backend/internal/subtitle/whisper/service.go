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
	"github.com/video-stream/backend/internal/storage"
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
		if backend.BackendType == "openvino-genai" {
			return NewOpenVINOGenAIClient(backend.URL), nil
		}
		return nil, fmt.Errorf("unsupported backend type: %s", backend.BackendType)
	}

	// Legacy: "openai" → use OpenAI API key from settings
	if engineKey == "openai" {
		key := s.database.GetSetting("openai_api_key", "")
		if key == "" {
			return nil, fmt.Errorf("OpenAI API key not configured")
		}
		return NewOpenAIWhisperClient(key), nil
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

	// 과거 작업에 모델이 없으면 현재 설정을 사용한다. 교체와 추론은 한 요청이다.
	if _, ok := engine.(*OpenVINOGenAIClient); ok && params.Model == "" {
		params.Model = s.database.GetSetting("whisper_model_id", "OpenVINO/whisper-large-v3-int8-ov")
	}
	if _, ok := engine.(*OpenVINOGenAIClient); !ok && strings.HasPrefix(params.Model, "Qwen/") {
		return fmt.Errorf("Qwen은 로컬 OpenVINO 연결에서만 사용할 수 있습니다")
	}

	// Resolve full path
	fullPath, err := storage.ResolveWithinBase(s.mediaPath, j.FilePath)
	if err != nil {
		return fmt.Errorf("resolve file path: %w", err)
	}
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		return fmt.Errorf("file not found: %s", j.FilePath)
	}

	log.Printf("[whisper] starting transcription: engine=%s file=%s language=%s",
		params.Engine, j.FilePath, params.Language)

	result, err := engine.Transcribe(ctx, TranscribeRequest{
		AudioTrack:    params.AudioTrack,
		FilePath:      fullPath,
		Language:      params.Language,
		Model:         params.Model,
		Prompt:        params.Hints,
		Lyrics:        params.Lyrics,
		ObserveSpeech: params.ObserveSpeech,
	}, updateProgress)
	if err != nil {
		return fmt.Errorf("transcribe: %w", err)
	}

	// Save VTT to subtitle output directory
	hash := videoHash(j.FilePath)
	outDir := filepath.Join(s.subtitlePath, hash)
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return fmt.Errorf("자막 폴더 생성 실패: %w", err)
	}

	lang := result.Language
	if lang == "" || lang == "auto" {
		lang = "auto"
	}
	if !storage.ValidFilenamePart(lang) {
		return fmt.Errorf("자막 언어가 올바르지 않습니다")
	}
	filename := fmt.Sprintf("whisper_%s.vtt", lang)
	if params.AudioTrack > 0 {
		filename = fmt.Sprintf("whisper_%s_track%d.vtt", lang, params.AudioTrack+1)
	}
	if strings.HasPrefix(params.Model, "Qwen/") {
		size := "1_7b"
		if strings.Contains(params.Model, "0.6B") {
			size = "0_6b"
		}
		filename = fmt.Sprintf("qwen3_%s_%s_track%d.vtt", lang, size, params.AudioTrack+1)
	}
	outFile := filepath.Join(outDir, filename)
	rawPath := ""
	if result.RawVTT != "" {
		if err := storage.WriteVersionedFile(ctx, outFile, strings.NewReader(result.RawVTT)); err != nil {
			return fmt.Errorf("원 추출본 저장: %w", err)
		}
		rawPath = "generated:" + filename
		filename = strings.TrimSuffix(filename, ".vtt") + "_lyrics.vtt"
		outFile = filepath.Join(outDir, filename)
	}

	if err := storage.WriteVersionedFile(ctx, outFile, strings.NewReader(result.VTT)); err != nil {
		return fmt.Errorf("save subtitle: %w", err)
	}

	log.Printf("[whisper] transcription complete: %s", outFile)

	// Store result in job
	resultJSON, _ := json.Marshal(job.TranscribeResult{
		OutputPath:  "generated:" + filename,
		Language:    lang,
		Model:       params.Model,
		RawPath:     rawPath,
		Diagnostics: result.Diagnostics,
	})
	j.Result = resultJSON

	updateProgress(1.0)
	return nil
}

func videoHash(videoPath string) string {
	h := sha256.Sum256([]byte(videoPath))
	return fmt.Sprintf("%x", h[:8])
}
