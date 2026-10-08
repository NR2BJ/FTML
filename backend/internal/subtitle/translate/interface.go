package translate

import "context"

// SubtitleCue represents a single subtitle entry with timing
type SubtitleCue struct {
	Index int     `json:"index"`
	Start float64 `json:"start"` // seconds
	End   float64 `json:"end"`   // seconds
	Text  string  `json:"text"`
}

// TranslateOptions configures translation behavior
type TranslateOptions struct {
	SourceLang   string `json:"source_lang"`
	TargetLang   string `json:"target_lang"`
	Preset       string `json:"preset"`        // "anime", "movie", "documentary", "custom"
	CustomPrompt string `json:"custom_prompt"` // for "custom" preset
}

// Translator는 번역 요청과 문장 검증을 분리한다.
type Translator interface {
	// Translate translates subtitle cues
	Translate(ctx context.Context, cues []SubtitleCue, opts TranslateOptions, updateProgress func(float64)) ([]SubtitleCue, error)
	// Name returns the engine name
	Name() string
}
