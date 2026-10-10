package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/video-stream/backend/internal/gpu"
	"github.com/video-stream/backend/internal/subtitle/whisper"
)

const defaultModelID = whisper.DefaultModelID

type WhisperModelsHandler struct{}

func NewWhisperModelsHandler() *WhisperModelsHandler { return &WhisperModelsHandler{} }

// 구버전 로컬 서버의 기본 모델 조회를 유지한다. 작업별 Qwen 선택과는 별개다.
func (h *WhisperModelsHandler) GetActiveModel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"model": defaultModelID})
}

func (h *WhisperModelsHandler) GPUInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(gpu.DetectGPU())
}
