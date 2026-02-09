package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/gpu"
)

// HuggingFace model response
type hfModel struct {
	ModelID   string   `json:"modelId"`
	Downloads int      `json:"downloads"`
	Tags      []string `json:"tags"`
}

// OpenVINO whisper model for frontend
type OVWhisperModel struct {
	ModelID     string `json:"model_id"`
	Label       string `json:"label"`
	Size        string `json:"size"`         // "tiny", "base", "small", "medium", "large-v3", "distil-large-v2", "distil-large-v3"
	Quant       string `json:"quant"`        // "int8", "int4", "fp16"
	EnglishOnly bool   `json:"english_only"` // true for .en models
	Downloads   int    `json:"downloads"`
	Active      bool   `json:"active"`
}

type WhisperModelsHandler struct {
	database *db.Database
	// Cache HuggingFace results (refreshed every 24h)
	cachedModels []OVWhisperModel
	cacheTime    time.Time
}

func NewWhisperModelsHandler(database *db.Database) *WhisperModelsHandler {
	return &WhisperModelsHandler{
		database: database,
	}
}

const defaultModelID = "OpenVINO/distil-whisper-large-v3-int8-ov"

// ListModels fetches OpenVINO whisper models from HuggingFace API
func (h *WhisperModelsHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	models, err := h.getModels()
	if err != nil {
		log.Printf("[whisper-models] failed to fetch models: %v", err)
		jsonError(w, "failed to fetch models", http.StatusInternalServerError)
		return
	}

	activeModel := h.database.GetSetting("whisper_model_id", defaultModelID)
	for i := range models {
		models[i].Active = models[i].ModelID == activeModel
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(models)
}

func (h *WhisperModelsHandler) getModels() ([]OVWhisperModel, error) {
	// Return cache if fresh (24h)
	if len(h.cachedModels) > 0 && time.Since(h.cacheTime) < 24*time.Hour {
		result := make([]OVWhisperModel, len(h.cachedModels))
		copy(result, h.cachedModels)
		return result, nil
	}

	client := &http.Client{Timeout: 10 * time.Second}
	url := "https://huggingface.co/api/models?author=OpenVINO&search=whisper+ov&sort=downloads&direction=-1&limit=50"

	resp, err := client.Get(url)
	if err != nil {
		// Return cache on network error
		if len(h.cachedModels) > 0 {
			result := make([]OVWhisperModel, len(h.cachedModels))
			copy(result, h.cachedModels)
			return result, nil
		}
		return nil, fmt.Errorf("HuggingFace API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if len(h.cachedModels) > 0 {
			result := make([]OVWhisperModel, len(h.cachedModels))
			copy(result, h.cachedModels)
			return result, nil
		}
		return nil, fmt.Errorf("HuggingFace API: status %d", resp.StatusCode)
	}

	var hfModels []hfModel
	if err := json.NewDecoder(resp.Body).Decode(&hfModels); err != nil {
		return nil, fmt.Errorf("parse HuggingFace response: %w", err)
	}

	var models []OVWhisperModel
	for _, m := range hfModels {
		// Only include models ending with "-ov"
		if !strings.HasSuffix(m.ModelID, "-ov") {
			continue
		}
		// Only OpenVINO/ org
		if !strings.HasPrefix(m.ModelID, "OpenVINO/") {
			continue
		}

		label := strings.TrimPrefix(m.ModelID, "OpenVINO/")
		label = strings.TrimSuffix(label, "-ov")

		// Parse quantization
		quant := "fp16"
		if strings.Contains(m.ModelID, "-int8") {
			quant = "int8"
		} else if strings.Contains(m.ModelID, "-int4") {
			quant = "int4"
		}

		// Parse english-only (.en models)
		englishOnly := strings.Contains(m.ModelID, ".en")

		// Parse model size
		size := parseModelSize(m.ModelID)

		models = append(models, OVWhisperModel{
			ModelID:     m.ModelID,
			Label:       label,
			Size:        size,
			Quant:       quant,
			EnglishOnly: englishOnly,
			Downloads:   m.Downloads,
		})
	}

	h.cachedModels = models
	h.cacheTime = time.Now()

	result := make([]OVWhisperModel, len(models))
	copy(result, models)
	return result, nil
}

// parseModelSize extracts the model size from HuggingFace model ID
// e.g. "OpenVINO/whisper-large-v3-int8-ov" → "large-v3"
//      "OpenVINO/distil-whisper-large-v3-int8-ov" → "distil-large-v3"
//      "OpenVINO/whisper-tiny.en-int8-ov" → "tiny"
func parseModelSize(modelID string) string {
	name := strings.TrimPrefix(modelID, "OpenVINO/")
	name = strings.TrimSuffix(name, "-ov")

	// Remove quantization suffix
	for _, q := range []string{"-int8", "-int4", "-fp16"} {
		name = strings.TrimSuffix(name, q)
	}

	// Remove .en suffix
	name = strings.TrimSuffix(name, ".en")

	// Handle distil models: "distil-whisper-large-v3" → "distil-large-v3"
	if strings.HasPrefix(name, "distil-whisper-") {
		rest := strings.TrimPrefix(name, "distil-whisper-")
		return "distil-" + rest
	}

	// Standard models: "whisper-large-v3" → "large-v3"
	if strings.HasPrefix(name, "whisper-") {
		return strings.TrimPrefix(name, "whisper-")
	}

	return name
}

// SetActiveModel changes the active model and tells the whisper server to load it
func (h *WhisperModelsHandler) SetActiveModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ModelID string `json:"model_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.ModelID == "" {
		jsonError(w, "model_id is required", http.StatusBadRequest)
		return
	}

	// Find openvino-genai backend and load the model synchronously
	// We do this BEFORE saving to DB so we don't store an unusable model ID
	backends, err := h.database.ListWhisperBackends()
	if err == nil {
		for _, b := range backends {
			if b.BackendType == "openvino-genai" && b.Enabled && b.URL != "" {
				if loadErr := h.notifyModelChange(b.URL, req.ModelID); loadErr != nil {
					jsonError(w, "failed to load model on whisper server: "+loadErr.Error(), http.StatusBadGateway)
					return
				}
				break
			}
		}
	}

	// Save to DB only after successful load
	if err := h.database.SetSetting("whisper_model_id", req.ModelID); err != nil {
		jsonError(w, "failed to save setting", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":   "ok",
		"model_id": req.ModelID,
	})
}

func (h *WhisperModelsHandler) notifyModelChange(backendURL, modelID string) error {
	url := strings.TrimRight(backendURL, "/") + "/v1/model/load"
	payload, _ := json.Marshal(map[string]string{"model_id": modelID})

	client := &http.Client{Timeout: 10 * time.Minute} // model download can be slow
	resp, err := client.Post(url, "application/json", strings.NewReader(string(payload)))
	if err != nil {
		log.Printf("[whisper-models] failed to notify model change: %v", err)
		return fmt.Errorf("whisper server unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		log.Printf("[whisper-models] model changed to %s on whisper server", modelID)
		return nil
	}

	respBody, _ := io.ReadAll(resp.Body)
	log.Printf("[whisper-models] whisper server returned %d for model change: %s", resp.StatusCode, string(respBody))
	return fmt.Errorf("whisper server returned %d: %s", resp.StatusCode, string(respBody))
}

// GetActiveModel returns the currently active model ID (internal, no auth)
func (h *WhisperModelsHandler) GetActiveModel(w http.ResponseWriter, r *http.Request) {
	activeModel := h.database.GetSetting("whisper_model_id", defaultModelID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"model": activeModel,
	})
}

// GPUInfo returns detected GPU information
func (h *WhisperModelsHandler) GPUInfo(w http.ResponseWriter, r *http.Request) {
	info := gpu.DetectGPU()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}
