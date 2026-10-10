package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/video-stream/backend/internal/job"
	"github.com/video-stream/backend/internal/storage"
	"github.com/video-stream/backend/internal/subtitle"
	"github.com/video-stream/backend/internal/subtitle/reference"
)

type SubtitleTaskRequest struct {
	Paths     []string             `json:"paths"`
	Mode      string               `json:"mode"`
	Generate  job.TranscribeParams `json:"generate"`
	Translate *job.TranslateParams `json:"translate,omitempty"`
}

type SubtitleTaskItem struct {
	Path       string `json:"path"`
	JobID      string `json:"job_id,omitempty"`
	SubtitleID string `json:"subtitle_id,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

func decodeSubtitleRequest(w http.ResponseWriter, r *http.Request, value any) bool {
	if err := json.NewDecoder(r.Body).Decode(value); err != nil {
		jsonError(w, "잘못된 작업 요청", http.StatusBadRequest)
		return false
	}
	return true
}

func (h *SubtitleHandler) SubmitSubtitleTasks(w http.ResponseWriter, r *http.Request) {
	var req SubtitleTaskRequest
	if decodeSubtitleRequest(w, r, &req) {
		h.submitSubtitleTasks(w, r, req, false)
	}
}

func validateSubtitleTask(req *SubtitleTaskRequest) error {
	if len(req.Paths) == 0 || len(req.Paths) > 200 {
		return fmt.Errorf("영상은 한 번에 1~200개를 선택해 주세요")
	}
	if req.Mode != "generate" && req.Mode != "translate" && req.Mode != "generate-translate" {
		return fmt.Errorf("잘못된 작업 종류")
	}
	if req.Mode != "translate" {
		if req.Generate.Lyrics != nil {
			return fmt.Errorf("가사 수동 보정은 지원하지 않습니다. 가사 없이 새 작업을 등록해 주세요")
		}
		if req.Generate.Model != "" && req.Generate.Model != "Qwen/Qwen3-ASR-1.7B" && req.Generate.Model != defaultModelID {
			return fmt.Errorf("지원하지 않는 비교 모델입니다")
		}
		if req.Generate.AudioTrack < 0 {
			return fmt.Errorf("잘못된 음성 트랙")
		}
		if req.Generate.Language == "" {
			req.Generate.Language = "auto"
		}
	}
	if req.Mode != "generate" {
		if req.Translate == nil || strings.TrimSpace(req.Translate.TargetLang) == "" {
			return fmt.Errorf("번역할 언어를 선택해 주세요")
		}
		if req.Translate.Engine == "" {
			req.Translate.Engine = "gemini"
		}
		if req.Translate.Engine != "gemini" {
			return fmt.Errorf("번역은 Gemini만 지원합니다")
		}
		if req.Translate.Preset == "" {
			req.Translate.Preset = "movie"
		}
		if len(req.Translate.CustomPrompt) > 32000 {
			return fmt.Errorf("번역 지침이 너무 깁니다")
		}
	}
	req.Generate.ChainTranslate = nil
	if req.Mode == "generate-translate" {
		copy := *req.Translate
		copy.SubtitleID = ""
		copy.SourceLabel = ""
		req.Generate.ChainTranslate = &copy
	}
	return nil
}

func (h *SubtitleHandler) submitSubtitleTasks(w http.ResponseWriter, r *http.Request, req SubtitleTaskRequest, single bool) {
	if err := validateSubtitleTask(&req); err != nil {
		jsonError(w, err.Error(), http.StatusBadRequest)
		return
	}
	// 등록 시 모델을 고정하고 실제 교체/추론은 서버의 동일 잠금 안에서 수행한다.
	if req.Mode != "translate" && req.Generate.Model == "" {
		req.Generate.Model = defaultModelID
	}
	items := make([]SubtitleTaskItem, 0, len(req.Paths))
	ids, skipped := []string{}, []string{}
	seen := make(map[string]bool)
	for _, raw := range req.Paths {
		if r.Context().Err() != nil {
			return
		}
		path := filepath.ToSlash(filepath.Clean(raw))
		if seen[path] {
			continue
		}
		seen[path] = true
		item := SubtitleTaskItem{Path: path}
		full, ok := h.safeVideoPath(path)
		if !ok {
			item.Reason = "접근할 수 없는 영상 경로입니다"
		}
		if item.Reason == "" {
			info, err := os.Stat(full)
			if err != nil || !info.Mode().IsRegular() || !storage.IsVideoFile(full) {
				item.Reason = "영상 파일을 찾을 수 없습니다"
			}
		}
		profile := reference.Load(h.database, path)
		generation := req.Generate
		generation.Hints = profile.Hints()
		if generation.ChainTranslate != nil {
			translation := *generation.ChainTranslate
			translation.Reference = profile.TranslationContext()
			generation.ChainTranslate = &translation
		}
		var params any = generation
		kind := job.JobTranscribe
		if item.Reason == "" && req.Mode == "translate" {
			translation := *req.Translate
			translation.SourceLabel = ""
			translation.Reference = profile.TranslationContext()
			entries := h.subtitleEntries(path, full, false)
			// 추출본/업로드본이 있으면 일괄 등록 때 모든 영상을 다시 조사하지 않는다.
			if strings.HasPrefix(translation.SubtitleID, "embedded:") ||
				translation.SubtitleID == "" && !strings.HasPrefix(chooseTranslationSource(entries), "generated:") {
				entries = append(embeddedSubtitleEntries(full), entries...)
			}
			if translation.SubtitleID == "" {
				translation.SubtitleID = chooseTranslationSource(entries)
			}
			found := false
			for _, entry := range entries {
				if entry.ID == translation.SubtitleID {
					found = true
					translation.SourceLabel = subtitleSourceLabel(entry)
					break
				}
			}
			if !found {
				item.Reason = "번역할 원본 자막이 없습니다"
			} else {
				// 목록에서 찾았더라도 파일이 사라졌거나 루트 밖 심볼릭 링크면 작업을 받지 않는다.
				if !strings.HasPrefix(translation.SubtitleID, "embedded:") {
					if _, err := subtitle.Load(r.Context(), h.mediaPath, h.subtitlePath, path, translation.SubtitleID); err != nil {
						item.Reason = "원본 자막을 읽을 수 없습니다"
					}
				}
			}
			item.SubtitleID = translation.SubtitleID
			params, kind = translation, job.JobTranslate
		}
		if item.Reason == "" {
			j, err := h.jobQueue.Enqueue(kind, path, params)
			if err != nil {
				item.Reason = "작업을 등록하지 못했습니다"
			} else {
				item.JobID = j.ID
				ids = append(ids, j.ID)
				action := "subtitle_generate"
				if kind == job.JobTranslate {
					action = "subtitle_translate"
				} else if req.Mode == "generate-translate" {
					action = "subtitle_generate_translate"
				}
				h.logSubtitleOp(r, action, path, req.Mode)
			}
		}
		if item.Reason != "" {
			skipped = append(skipped, path)
		}
		items = append(items, item)
	}
	if single {
		if len(items) == 0 {
			jsonError(w, "등록할 영상이 없습니다", http.StatusBadRequest)
			return
		}
		if items[0].JobID == "" {
			jsonError(w, items[0].Reason, http.StatusBadRequest)
			return
		}
		jsonResponse(w, map[string]string{"job_id": items[0].JobID}, http.StatusCreated)
		return
	}
	jsonResponse(w, map[string]any{"items": items, "job_ids": ids, "skipped": skipped}, http.StatusCreated)
}

// 기존 우선순위를 보존하되 목록과 자동 선택의 파일 판별은 하나로 통일한다.
func chooseTranslationSource(entries []SubtitleEntry) string {
	for _, category := range []string{"whisper", "generated", "embedded", "external"} {
		for _, entry := range entries {
			if strings.HasPrefix(entry.ID, "generated:translate_") {
				continue
			}
			if category == "whisper" && strings.HasPrefix(entry.ID, "generated:whisper_") || category == entry.Type {
				return entry.ID
			}
		}
	}
	return ""
}
