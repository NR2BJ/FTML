package whisper

import "context"

// TranscribeRequest is the input for a transcription
type TranscribeRequest struct {
	FilePath string // absolute path to the media file
	Language string // "auto", "ko", "en", "ja", etc.
	Model    string // model name/size (for OpenAI: "whisper-1", for local: model path)
}

// TranscribeResult is the output of a transcription
type TranscribeResult struct {
	VTT      string // WebVTT content
	Language string // detected language
}

// Transcriber is the common interface for all whisper engines
type Transcriber interface {
	// Transcribe converts audio/video to subtitles
	Transcribe(ctx context.Context, req TranscribeRequest, updateProgress func(float64)) (*TranscribeResult, error)
	// Name returns the engine name
	Name() string
}
