package translate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/job"
	"github.com/video-stream/backend/internal/storage"
	"github.com/video-stream/backend/internal/subtitle"
)

// Service manages translation engines and processes translation jobs
type Service struct {
	database      *db.Database
	mediaPath     string
	subtitlePath  string
	modelResolver ModelResolver
}

// NewService creates a translation service that resolves API keys dynamically from DB.
func NewService(mediaPath, subtitlePath string, database *db.Database, geminiModelResolver ModelResolver) *Service {
	return &Service{
		database:      database,
		mediaPath:     mediaPath,
		subtitlePath:  subtitlePath,
		modelResolver: geminiModelResolver,
	}
}

func (s *Service) resolveEngine(name string) (Translator, error) {
	switch name {
	case "gemini":
		key := s.database.GetSetting("gemini_api_key", "")
		if key == "" {
			return nil, fmt.Errorf("Gemini API key not configured")
		}
		return NewGeminiTranslator(key, s.modelResolver), nil
	default:
		return nil, fmt.Errorf("unknown translation engine: %s", name)
	}
}

// HandleJob processes a translation job
func (s *Service) HandleJob(ctx context.Context, j *job.Job, updateProgress func(float64)) error {
	var params job.TranslateParams
	if err := json.Unmarshal(j.Params, &params); err != nil {
		return fmt.Errorf("unmarshal params: %w", err)
	}
	if !storage.ValidFilenamePart(params.TargetLang) || !storage.ValidFilenamePart(params.Engine) {
		return fmt.Errorf("번역 언어 또는 번역기 이름이 올바르지 않습니다")
	}

	engine, err := s.resolveEngine(params.Engine)
	if err != nil {
		return err
	}

	doc, err := subtitle.Load(ctx, s.mediaPath, s.subtitlePath, j.FilePath, params.SubtitleID)
	if err != nil {
		return fmt.Errorf("자막 읽기: %w", err)
	}
	var assPlan *subtitle.ASSTranslation
	var cues []SubtitleCue
	if subtitle.IsASS(doc.Format) {
		assPlan = subtitle.PrepareASSTranslation(doc.Data)
		for _, event := range assPlan.Texts {
			cues = append(cues, SubtitleCue{Index: event.ID, Start: event.Start, End: event.End, Text: event.Text})
		}
	} else {
		data, err := doc.VTT(ctx)
		if err != nil {
			return err
		}
		cues = ParseVTT(string(data))
	}
	if len(cues) == 0 {
		return fmt.Errorf("no subtitle cues found in source")
	}

	// Filter out non-text cues (ASS drawing commands, empty cues)
	var textCues []SubtitleCue
	skippedMap := make(map[int]bool) // cue index → skipped
	for _, cue := range cues {
		if isNonTextCue(strings.TrimSpace(cue.Text)) {
			skippedMap[cue.Index] = true
		} else {
			textCues = append(textCues, cue)
		}
	}
	if len(skippedMap) > 0 {
		log.Printf("[translate] filtered %d non-text cues (ASS drawing/empty), %d remain", len(skippedMap), len(textCues))
	}

	if len(textCues) == 0 {
		return fmt.Errorf("no translatable subtitle cues found after filtering")
	}

	log.Printf("[translate] translating %d cues: engine=%s target=%s preset=%s",
		len(textCues), params.Engine, params.TargetLang, params.Preset)

	// Detect source language from subtitle ID (e.g., "generated:whisper_ja.vtt" → "ja")
	sourceLang := detectSourceLang(params.SubtitleID)

	// Translate
	translatedText, err := engine.Translate(ctx, textCues, TranslateOptions{
		SourceLang:   sourceLang,
		TargetLang:   params.TargetLang,
		Preset:       params.Preset,
		CustomPrompt: params.CustomPrompt,
	}, updateProgress)
	if err != nil {
		return fmt.Errorf("translate: %w", err)
	}
	if err := validateTranslatedCues(textCues, translatedText); err != nil {
		return err
	}

	// Merge skipped cues back with translated results
	var translated []SubtitleCue
	ti := 0
	for _, origCue := range cues {
		if skippedMap[origCue.Index] {
			translated = append(translated, origCue) // keep original
		} else if ti < len(translatedText) {
			translated = append(translated, translatedText[ti])
			ti++
		}
	}

	// Save translated VTT
	hash := videoHash(j.FilePath)
	outDir := filepath.Join(s.subtitlePath, hash)
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return fmt.Errorf("자막 폴더 생성 실패: %w", err)
	}

	content := CuesToVTT(translated)
	ext := "vtt"
	fallbacks := 0
	if assPlan != nil {
		byID := make(map[int]string, len(translated))
		for _, cue := range translated {
			byID[cue.Index] = cue.Text
		}
		data, err := assPlan.Render(byID)
		if err != nil {
			return err
		}
		content, ext, fallbacks = string(data), "ass", assPlan.Fallbacks
	}
	// 다른 원본의 번역과 기존 VTT를 덮어쓰지 않는다.
	sourceKey := sha256.Sum256([]byte(params.SubtitleID))
	filename := fmt.Sprintf("translate_%s_%s_%x.%s", params.TargetLang, params.Engine, sourceKey[:8], ext)
	outFile := filepath.Join(outDir, filename)

	if err := storage.WriteVersionedFile(ctx, outFile, strings.NewReader(content)); err != nil {
		return fmt.Errorf("save translated subtitle: %w", err)
	}

	log.Printf("[translate] translation complete: %s", outFile)

	// Store result in job
	resultJSON, _ := json.Marshal(map[string]any{
		"output_path":            "generated:" + filename,
		"plain_effect_fallbacks": fallbacks,
	})
	j.Result = resultJSON

	updateProgress(1.0)
	return nil
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
		return strings.SplitN(strings.TrimPrefix(name, "whisper_"), "_", 2)[0]
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

func videoHash(videoPath string) string {
	h := sha256.Sum256([]byte(videoPath))
	return fmt.Sprintf("%x", h[:8])
}

// assDrawingRe matches ASS drawing commands like {=17}m -484.5 -210 l ...
var assDrawingRe = regexp.MustCompile(`^\{[=\\][^}]*\}m\s+[-\d]`)

// isNonTextCue returns true if a cue contains non-translatable content
func isNonTextCue(text string) bool {
	if text == "" {
		return true
	}
	// ASS drawing command: {=17}m -484.5 -210 l ...
	if assDrawingRe.MatchString(text) {
		return true
	}
	return false
}
