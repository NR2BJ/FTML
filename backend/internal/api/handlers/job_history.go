package handlers

import (
	"net/http"
	"strconv"
	"strings"
)

func historyPage(r *http.Request) (int, bool) {
	value := r.URL.Query().Get("page")
	if value == "" {
		return 1, true
	}
	page, err := strconv.Atoi(value)
	return page, err == nil && page > 0 && page <= 1000000
}

func (h *JobHandler) VideoHistory(w http.ResponseWriter, r *http.Request) {
	page, ok := historyPage(r)
	if !ok {
		jsonError(w, "잘못된 페이지", http.StatusBadRequest)
		return
	}
	status := r.URL.Query().Get("status")
	switch status {
	case "", "all", "active", "completed", "failed":
	default:
		jsonError(w, "잘못된 상태 필터", http.StatusBadRequest)
		return
	}
	result, err := h.queue.VideoHistory(r.URL.Query().Get("q"), status, page)
	if err != nil {
		jsonError(w, "작업한 영상 목록을 읽지 못했습니다", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, result, http.StatusOK)
}

func (h *JobHandler) HistoryForVideo(w http.ResponseWriter, r *http.Request) {
	page, ok := historyPage(r)
	path := r.URL.Query().Get("path")
	if !ok || path == "" {
		jsonError(w, "영상 경로와 페이지를 확인해 주세요", http.StatusBadRequest)
		return
	}
	items, total, err := h.queue.HistoryForVideo(path, page)
	if err != nil {
		jsonError(w, "작업 이력을 읽지 못했습니다", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, map[string]any{"items": items, "total": total, "page": page, "page_size": 50}, http.StatusOK)
}

func (h *JobHandler) TrackedJobs(w http.ResponseWriter, r *http.Request) {
	ids := strings.Split(r.URL.Query().Get("ids"), ",")
	if len(ids) > 200 || len(ids) == 1 && ids[0] == "" {
		jsonError(w, "작업 번호는 1~200개까지 조회할 수 있습니다", http.StatusBadRequest)
		return
	}
	jobs, err := h.queue.TrackedJobs(ids)
	if err != nil {
		jsonError(w, "작업 상태 조회 실패", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, jobs, http.StatusOK)
}
