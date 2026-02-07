package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/video-stream/backend/internal/db"
)

// Available whisper.cpp models on HuggingFace
var whisperModels = []WhisperModelDef{
	{Name: "ggml-large-v3-turbo.bin", Label: "Large V3 Turbo", Size: "1.6 GB", SizeBytes: 1624236544, Description: "Best speed/quality balance (recommended)"},
	{Name: "ggml-large-v3.bin", Label: "Large V3", Size: "3.1 GB", SizeBytes: 3094623232, Description: "Best quality, slowest"},
	{Name: "ggml-medium.bin", Label: "Medium", Size: "1.5 GB", SizeBytes: 1533774592, Description: "Good quality, moderate speed"},
	{Name: "ggml-small.bin", Label: "Small", Size: "488 MB", SizeBytes: 487601664, Description: "Fast, decent quality"},
	{Name: "ggml-base.bin", Label: "Base", Size: "148 MB", SizeBytes: 147951465, Description: "Very fast, basic quality"},
	{Name: "ggml-tiny.bin", Label: "Tiny", Size: "78 MB", SizeBytes: 77691713, Description: "Fastest, low quality"},
}

const huggingfaceBaseURL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

type WhisperModelDef struct {
	Name        string `json:"name"`
	Label       string `json:"label"`
	Size        string `json:"size"`
	SizeBytes   int64  `json:"size_bytes"`
	Description string `json:"description"`
}

type WhisperModelStatus struct {
	WhisperModelDef
	Downloaded bool    `json:"downloaded"`
	Active     bool    `json:"active"`
	Progress   float64 `json:"progress,omitempty"` // 0-1 if downloading
}

type WhisperModelsHandler struct {
	modelPath string
	database  *db.Database

	mu          sync.RWMutex
	downloading map[string]*downloadState
}

type downloadState struct {
	Progress    float64
	Error       string
	Done        bool
	Cancel      chan struct{}
}

func NewWhisperModelsHandler(modelPath string, database *db.Database) *WhisperModelsHandler {
	os.MkdirAll(modelPath, 0755)
	return &WhisperModelsHandler{
		modelPath:   modelPath,
		database:    database,
		downloading: make(map[string]*downloadState),
	}
}

// ListModels returns available models with download/active status
func (h *WhisperModelsHandler) ListModels(w http.ResponseWriter, r *http.Request) {
	activeModel := h.database.GetSetting("whisper_model", "ggml-large-v3.bin")

	h.mu.RLock()
	defer h.mu.RUnlock()

	var result []WhisperModelStatus
	for _, def := range whisperModels {
		status := WhisperModelStatus{
			WhisperModelDef: def,
			Active:          def.Name == activeModel,
		}

		// Check if file exists and is fully downloaded
		filePath := filepath.Join(h.modelPath, def.Name)
		if info, err := os.Stat(filePath); err == nil {
			// Consider downloaded if file size is at least 90% of expected
			// (some model files may vary slightly)
			if info.Size() >= def.SizeBytes*9/10 {
				status.Downloaded = true
			}
		}

		// Check if currently downloading
		if ds, ok := h.downloading[def.Name]; ok && !ds.Done {
			status.Progress = ds.Progress
		}

		result = append(result, status)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// DownloadModel starts downloading a model from HuggingFace
func (h *WhisperModelsHandler) DownloadModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Validate model name
	var modelDef *WhisperModelDef
	for _, m := range whisperModels {
		if m.Name == req.Model {
			def := m
			modelDef = &def
			break
		}
	}
	if modelDef == nil {
		jsonError(w, "unknown model: "+req.Model, http.StatusBadRequest)
		return
	}

	// Check if already downloading
	h.mu.Lock()
	if ds, ok := h.downloading[req.Model]; ok && !ds.Done {
		h.mu.Unlock()
		jsonError(w, "already downloading", http.StatusConflict)
		return
	}

	// Check if already downloaded
	filePath := filepath.Join(h.modelPath, req.Model)
	if info, err := os.Stat(filePath); err == nil && info.Size() >= modelDef.SizeBytes*9/10 {
		h.mu.Unlock()
		jsonError(w, "model already downloaded", http.StatusConflict)
		return
	}

	ds := &downloadState{Cancel: make(chan struct{})}
	h.downloading[req.Model] = ds
	h.mu.Unlock()

	// Start download in background
	go h.downloadModel(modelDef, ds)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "downloading"})
}

// DownloadProgress returns the progress of a model download
func (h *WhisperModelsHandler) DownloadProgress(w http.ResponseWriter, r *http.Request) {
	model := r.URL.Query().Get("model")
	if model == "" {
		jsonError(w, "model parameter required", http.StatusBadRequest)
		return
	}

	h.mu.RLock()
	ds, ok := h.downloading[model]
	h.mu.RUnlock()

	if !ok {
		// Check if file exists (already downloaded)
		for _, m := range whisperModels {
			if m.Name == model {
				filePath := filepath.Join(h.modelPath, model)
				if info, err := os.Stat(filePath); err == nil && info.Size() >= m.SizeBytes*9/10 {
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]interface{}{
						"progress": 1.0,
						"done":     true,
					})
					return
				}
			}
		}
		jsonError(w, "no download in progress", http.StatusNotFound)
		return
	}

	h.mu.RLock()
	progress := ds.Progress
	done := ds.Done
	dlError := ds.Error
	h.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"progress": progress,
		"done":     done,
		"error":    dlError,
	})
}

// DeleteModel removes a downloaded model file
func (h *WhisperModelsHandler) DeleteModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Validate model name (security: prevent path traversal)
	valid := false
	for _, m := range whisperModels {
		if m.Name == req.Model {
			valid = true
			break
		}
	}
	if !valid {
		jsonError(w, "unknown model", http.StatusBadRequest)
		return
	}

	// Don't delete active model
	activeModel := h.database.GetSetting("whisper_model", "ggml-large-v3.bin")
	if req.Model == activeModel {
		jsonError(w, "cannot delete the active model", http.StatusConflict)
		return
	}

	// Cancel any ongoing download
	h.mu.Lock()
	if ds, ok := h.downloading[req.Model]; ok && !ds.Done {
		close(ds.Cancel)
	}
	delete(h.downloading, req.Model)
	h.mu.Unlock()

	filePath := filepath.Join(h.modelPath, req.Model)
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		jsonError(w, "failed to delete model", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// SetActiveModel changes the active whisper model
func (h *WhisperModelsHandler) SetActiveModel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Validate model exists on disk
	valid := false
	for _, m := range whisperModels {
		if m.Name == req.Model {
			filePath := filepath.Join(h.modelPath, req.Model)
			if info, err := os.Stat(filePath); err == nil && info.Size() >= m.SizeBytes*9/10 {
				valid = true
			}
			break
		}
	}
	if !valid {
		jsonError(w, "model not downloaded yet", http.StatusBadRequest)
		return
	}

	if err := h.database.SetSetting("whisper_model", req.Model); err != nil {
		jsonError(w, "failed to save setting", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "active",
		"model":  req.Model,
		"note":   "Restart the whisper-sycl container to apply: docker compose restart whisper-sycl",
	})
}

func (h *WhisperModelsHandler) downloadModel(model *WhisperModelDef, ds *downloadState) {
	url := fmt.Sprintf("%s/%s", huggingfaceBaseURL, model.Name)
	filePath := filepath.Join(h.modelPath, model.Name)
	tmpPath := filePath + ".tmp"

	log.Printf("[whisper-models] downloading %s from %s", model.Name, url)

	// Check for existing partial download
	var startByte int64
	if info, err := os.Stat(tmpPath); err == nil {
		startByte = info.Size()
	}

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		h.setDownloadError(model.Name, ds, err)
		return
	}

	// Resume download if partial file exists
	if startByte > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", startByte))
		log.Printf("[whisper-models] resuming from byte %d", startByte)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.setDownloadError(model.Name, ds, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		h.setDownloadError(model.Name, ds, fmt.Errorf("HTTP %d", resp.StatusCode))
		return
	}

	// If server doesn't support Range, start from scratch
	if startByte > 0 && resp.StatusCode != http.StatusPartialContent {
		startByte = 0
	}

	// Open file for writing (append if resuming)
	var flags int
	if startByte > 0 {
		flags = os.O_WRONLY | os.O_APPEND
	} else {
		flags = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	}
	out, err := os.OpenFile(tmpPath, flags, 0644)
	if err != nil {
		h.setDownloadError(model.Name, ds, err)
		return
	}
	defer out.Close()

	totalSize := model.SizeBytes
	downloaded := startByte
	buf := make([]byte, 256*1024) // 256KB chunks

	for {
		select {
		case <-ds.Cancel:
			log.Printf("[whisper-models] download cancelled: %s", model.Name)
			h.mu.Lock()
			ds.Done = true
			ds.Error = "cancelled"
			h.mu.Unlock()
			return
		default:
		}

		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				h.setDownloadError(model.Name, ds, writeErr)
				return
			}
			downloaded += int64(n)

			h.mu.Lock()
			if totalSize > 0 {
				ds.Progress = float64(downloaded) / float64(totalSize)
			}
			h.mu.Unlock()
		}

		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			// Check if cancelled
			select {
			case <-ds.Cancel:
				return
			default:
			}
			h.setDownloadError(model.Name, ds, readErr)
			return
		}
	}

	out.Close()

	// Rename tmp to final
	if err := os.Rename(tmpPath, filePath); err != nil {
		h.setDownloadError(model.Name, ds, err)
		return
	}

	h.mu.Lock()
	ds.Progress = 1.0
	ds.Done = true
	h.mu.Unlock()

	// Verify file size
	if info, err := os.Stat(filePath); err == nil {
		if strings.HasSuffix(model.Name, ".bin") {
			log.Printf("[whisper-models] download complete: %s (%.1f MB)", model.Name, float64(info.Size())/1024/1024)
		}
	}
}

func (h *WhisperModelsHandler) setDownloadError(name string, ds *downloadState, err error) {
	log.Printf("[whisper-models] download error for %s: %v", name, err)
	h.mu.Lock()
	ds.Done = true
	ds.Error = err.Error()
	h.mu.Unlock()
}
