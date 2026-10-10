package whisper

import (
	"context"

	"github.com/video-stream/backend/internal/job"
)

// TranscribeRequest is the input for a transcription
type TranscribeRequest struct {
	AudioTrack    int
	FilePath      string // absolute path to the media file
	Language      string // "auto", "ko", "en", "ja", etc.
	Model         string // model name/size (for OpenAI: "whisper-1", for local: model path)
	Prompt        string // 작품별 원어 이름과 읽기 힌트
	Lyrics        *job.LyricsReference
	ObserveSpeech bool
}

// TranscribeResult is the output of a transcription
type TranscribeResult struct {
	VTT         string // WebVTT content
	RawVTT      string // 참고 가사를 적용하기 전 원 추출본
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
