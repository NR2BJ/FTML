package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/video-stream/backend/internal/db"
)

// settingsKeys defines which keys are allowed and their display metadata
var settingsKeys = []SettingDef{
	{Key: "whisper_model", Label: "Whisper Model", Group: "whisper", Placeholder: "ggml-large-v3.bin", Secret: false},
	{Key: "whisper_language", Label: "Default Language", Group: "whisper", Placeholder: "auto", Secret: false},
	{Key: "gemini_api_key", Label: "Gemini API Key", Group: "translation", Placeholder: "AIza...", Secret: true},
	{Key: "gemini_model", Label: "Gemini Model", Group: "translation", Placeholder: "gemini-2.0-flash", Secret: false},
	{Key: "openai_api_key", Label: "OpenAI API Key", Group: "translation", Placeholder: "sk-...", Secret: true},
	{Key: "deepl_api_key", Label: "DeepL API Key", Group: "translation", Placeholder: "xxxxxxxx-xxxx-...", Secret: true},
}

type SettingDef struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Group       string `json:"group"`
	Placeholder string `json:"placeholder"`
	Secret      bool   `json:"secret"`
}

type SettingsHandler struct {
	database *db.Database
}

func NewSettingsHandler(database *db.Database) *SettingsHandler {
	return &SettingsHandler{database: database}
}

// GetSettings returns all settings (secrets are masked)
func (h *SettingsHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	all, err := h.database.GetAllSettings()
	if err != nil {
		jsonError(w, "failed to load settings", http.StatusInternalServerError)
		return
	}

	// Build response with metadata and masked values
	type SettingResponse struct {
		SettingDef
		Value    string `json:"value"`
		HasValue bool   `json:"has_value"`
	}

	var result []SettingResponse
	for _, def := range settingsKeys {
		val := all[def.Key]
		masked := val
		hasValue := val != ""
		if def.Secret && hasValue {
			// Show only last 4 chars
			if len(val) > 4 {
				masked = "••••••••" + val[len(val)-4:]
			} else {
				masked = "••••••••"
			}
		}
		result = append(result, SettingResponse{
			SettingDef: def,
			Value:      masked,
			HasValue:   hasValue,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// UpdateSettings saves settings from the request body
func (h *SettingsHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	var updates map[string]string
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Validate keys — only allow known settings
	allowed := make(map[string]bool)
	for _, def := range settingsKeys {
		allowed[def.Key] = true
	}

	for key, value := range updates {
		if !allowed[key] {
			continue
		}
		// Skip masked values (don't overwrite with mask)
		if len(value) > 0 && value[0] == 0xe2 { // "•" starts with 0xe2 in UTF-8
			continue
		}
		if value == "" || (len(value) > 8 && value[:len("••••••••")] == "••••••••") {
			// Skip empty or masked values — don't clear existing secrets
			if value == "" {
				// Explicit clear
				h.database.SetSetting(key, "")
			}
			continue
		}
		if err := h.database.SetSetting(key, value); err != nil {
			jsonError(w, "failed to save setting: "+key, http.StatusInternalServerError)
			return
		}
	}

	w.WriteHeader(http.StatusNoContent)
}
