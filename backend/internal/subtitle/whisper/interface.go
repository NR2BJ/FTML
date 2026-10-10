package whisper

import (
	"context"
)

// TranscribeRequest is the input for a transcription
type TranscribeRequest struct {
	AudioTrack    int
	FilePath      string // absolute path to the media file
	Language      string // "auto", "ko", "en", "ja", etc.
	Model         string // model name/size (for OpenAI: "whisper-1", for local: model path)
	Prompt        string // 작품별 원어 이름과 읽기 힌트
	ObserveSpeech bool
}

// TranscribeResult is the output of a transcription
type TranscribeResult struct {
	VTT         string // WebVTT content
	Diagnostics map[string]any
	Language    string // detected language
}

// Transcriber is the common interface for all whisper engines
type Transcriber interface {
	// Transcribe converts audio/video to subtitles
	Transcribe(ctx context.Context, req TranscribeRequest, updateProgress func(float64)) (*TranscribeResult, error)
	// Name returns the engine name
	Name() string
}
