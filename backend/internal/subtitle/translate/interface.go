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

// Translator is the common interface for all translation engines
type Translator interface {
	// Translate translates subtitle cues
	Translate(ctx context.Context, cues []SubtitleCue, opts TranslateOptions, updateProgress func(float64)) ([]SubtitleCue, error)
	// Name returns the engine name
	Name() string
}
