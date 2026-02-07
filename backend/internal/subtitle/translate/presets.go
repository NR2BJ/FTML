package translate

import "fmt"

// GetSystemPrompt returns the translation system prompt for a given preset
func GetSystemPrompt(preset, sourceLang, targetLang string) string {
	base := fmt.Sprintf(
		"You are a professional subtitle translator. Translate subtitles from %s to %s. "+
			"Maintain the original meaning and timing constraints. "+
			"Keep translations concise and natural for subtitle display. "+
			"Respond with ONLY the translated text for each subtitle cue, maintaining the same number of lines.",
		langName(sourceLang), langName(targetLang),
	)

	switch preset {
	case "anime":
		return base + "\n\n" +
			"Additional guidelines for anime translation:\n" +
			"- Use casual, natural speech patterns appropriate for anime dialogue\n" +
			"- Preserve Japanese honorifics (-san, -kun, -chan, -senpai, -sensei) when translating to Korean\n" +
			"- Handle common anime expressions naturally (e.g., なるほど, すごい, やれやれ)\n" +
			"- Keep character name consistency\n" +
			"- Match the emotional tone (excited, serious, comedic)\n" +
			"- Translate onomatopoeia and sound effects appropriately"

	case "movie":
		return base + "\n\n" +
			"Additional guidelines for movie/drama translation:\n" +
			"- Use natural conversational style appropriate for the genre\n" +
			"- Preserve cultural nuances and idioms with equivalent expressions\n" +
			"- Maintain formal/informal register matching the original dialogue\n" +
			"- Keep subtitles readable within typical display time (max 2 lines)"

	case "documentary":
		return base + "\n\n" +
			"Additional guidelines for documentary translation:\n" +
			"- Use formal, precise language\n" +
			"- Preserve all technical terminology with accurate translations\n" +
			"- Maintain proper nouns, scientific names, and place names\n" +
			"- Keep numbers, dates, and measurements accurate\n" +
			"- Use standard academic style for narration"

	case "custom":
		return base

	default:
		return base
	}
}

func langName(code string) string {
	names := map[string]string{
		"ko":    "Korean",
		"en":    "English",
		"ja":    "Japanese",
		"zh":    "Chinese",
		"es":    "Spanish",
		"fr":    "French",
		"de":    "German",
		"pt":    "Portuguese",
		"it":    "Italian",
		"ru":    "Russian",
		"ar":    "Arabic",
		"hi":    "Hindi",
		"th":    "Thai",
		"vi":    "Vietnamese",
		"id":    "Indonesian",
		"auto":  "auto-detected language",
	}
	if name, ok := names[code]; ok {
		return name
	}
	return code
}
