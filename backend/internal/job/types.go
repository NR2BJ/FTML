package job

import (
	"context"
	"encoding/json"
	"time"
)

// JobType represents the kind of job
type JobType string

const (
	JobTranscribe JobType = "transcribe"
	JobTranslate  JobType = "translate"
)

// JobStatus represents the current state of a job
type JobStatus string

const (
	StatusPending   JobStatus = "pending"
	StatusRunning   JobStatus = "running"
	StatusCompleted JobStatus = "completed"
	StatusFailed    JobStatus = "failed"
	StatusCancelled JobStatus = "cancelled"
)

// Job represents a queued task (subtitle generation or translation)
type Job struct {
	ID          string          `json:"id"`
	Type        JobType         `json:"type"`
	Status      JobStatus       `json:"status"`
	FilePath    string          `json:"file_path"`
	Params      json.RawMessage `json:"params"`
	Progress    float64         `json:"progress"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       string          `json:"error,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	StartedAt   *time.Time      `json:"started_at,omitempty"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
}

// TranscribeParams are parameters for a transcription job
type TranscribeParams struct {
	Engine         string          `json:"engine"`                    // "whisper.cpp", "faster-whisper", "openai"
	Model          string          `json:"model"`                    // "tiny", "base", "small", "medium", "large-v3"
	Language       string          `json:"language"`                 // "auto", "ko", "en", "ja", etc.
	ChainTranslate *TranslateParams `json:"chain_translate,omitempty"` // auto-translate after transcribe completes
}

// TranslateParams are parameters for a translation job
type TranslateParams struct {
	SubtitleID   string `json:"subtitle_id"`   // source subtitle ID (e.g., "generated:whisper_ja.vtt")
	TargetLang   string `json:"target_lang"`   // "ko", "en", "ja", etc.
	Engine       string `json:"engine"`        // "gemini", "openai", "deepl"
	Preset       string `json:"preset"`        // "anime", "movie", "documentary", "custom"
	CustomPrompt string `json:"custom_prompt"` // for "custom" preset
}

// TranscribeResult is the output of a successful transcription
type TranscribeResult struct {
	OutputPath string `json:"output_path"` // relative path to generated VTT
	Language   string `json:"language"`    // detected or specified language
	Duration   float64 `json:"duration"`   // processing time in seconds
}

// TranslateResult is the output of a successful translation
type TranslateResult struct {
	OutputPath string `json:"output_path"` // relative path to translated VTT
	Duration   float64 `json:"duration"`   // processing time in seconds
}

// JobHandler processes a job. Implementations are provided by whisper/translate packages.
type JobHandler func(ctx context.Context, job *Job, updateProgress func(float64)) error
