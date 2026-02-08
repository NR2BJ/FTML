package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/video-stream/backend/internal/db"
)

// GeminiModel is the frontend-friendly model info
type GeminiModel struct {
	ID          string `json:"id"`          // e.g. "gemini-2.5-flash"
	DisplayName string `json:"display_name"` // e.g. "Gemini 2.5 Flash"
	Description string `json:"description"`
}

type GeminiModelsHandler struct {
	database     *db.Database
	cachedModels []GeminiModel
	cacheTime    time.Time
}

func NewGeminiModelsHandler(database *db.Database) *GeminiModelsHandler {
	return &GeminiModelsHandler{database: database}
}

// ListModels fetches available Gemini text models from Google API
func (h *GeminiModelsHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	apiKey := h.database.GetSetting("gemini_api_key", "")
	if apiKey == "" {
		// Return empty list if no API key configured
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]GeminiModel{})
		return
	}

	models, err := h.getModels(apiKey)
	if err != nil {
		jsonError(w, "failed to fetch Gemini models: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)
}

func (h *GeminiModelsHandler) getModels(apiKey string) ([]GeminiModel, error) {
	// Return cache if fresh (1h)
	if len(h.cachedModels) > 0 && time.Since(h.cacheTime) < 1*time.Hour {
		result := make([]GeminiModel, len(h.cachedModels))
		copy(result, h.cachedModels)
		return result, nil
	}

	client := &http.Client{Timeout: 10 * time.Second}
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models?key=%s&pageSize=100", apiKey)

	resp, err := client.Get(url)
	if err != nil {
		if len(h.cachedModels) > 0 {
			result := make([]GeminiModel, len(h.cachedModels))
			copy(result, h.cachedModels)
			return result, nil
		}
		return nil, fmt.Errorf("Google API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if len(h.cachedModels) > 0 {
			result := make([]GeminiModel, len(h.cachedModels))
			copy(result, h.cachedModels)
			return result, nil
		}
		return nil, fmt.Errorf("Google API: status %d", resp.StatusCode)
	}

	var apiResp struct {
		Models []struct {
			Name                       string   `json:"name"`        // "models/gemini-2.5-flash"
			DisplayName                string   `json:"displayName"` // "Gemini 2.5 Flash"
			Description                string   `json:"description"`
			SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return nil, fmt.Errorf("parse Google API response: %w", err)
	}

	var models []GeminiModel
	seen := make(map[string]bool)

	for _, m := range apiResp.Models {
		// Only include models that support generateContent (text generation)
		supportsGenerate := false
		for _, method := range m.SupportedGenerationMethods {
			if method == "generateContent" {
				supportsGenerate = true
				break
			}
		}
		if !supportsGenerate {
			continue
		}

		// Extract model ID: "models/gemini-2.5-flash" → "gemini-2.5-flash"
		id := strings.TrimPrefix(m.Name, "models/")

		// Skip embedding models, vision-only, AQA, etc.
		if strings.Contains(id, "embedding") ||
			strings.Contains(id, "aqa") ||
			strings.Contains(id, "imagen") ||
			strings.Contains(id, "veo") ||
			strings.Contains(id, "lyria") ||
			strings.Contains(id, "learnlm") {
			continue
		}

		// Only include gemini models
		if !strings.HasPrefix(id, "gemini-") {
			continue
		}

		// Deduplicate (skip if already seen)
		if seen[id] {
			continue
		}
		seen[id] = true

		models = append(models, GeminiModel{
			ID:          id,
			DisplayName: m.DisplayName,
			Description: m.Description,
		})
	}

	// Sort: newer models first (higher version numbers)
	sort.Slice(models, func(i, j int) bool {
		return models[i].ID > models[j].ID
	})

	h.cachedModels = models
	h.cacheTime = time.Now()

	result := make([]GeminiModel, len(models))
	copy(result, models)
	return result, nil
}
