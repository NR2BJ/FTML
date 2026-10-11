package handlers

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/video-stream/backend/internal/storage"
)

func (h *SubtitleHandler) ListSubtitleTrash(w http.ResponseWriter, r *http.Request) {
	entries, err := storage.ListSubtitleTrash(filepath.Join(h.subtitlePath, videoHash(extractPath(r))))
	if err != nil {
		jsonError(w, "휴지통 목록을 읽지 못했습니다", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, entries, http.StatusOK)
}

func (h *SubtitleHandler) RestoreSubtitle(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	entry, err := storage.RestoreSubtitle(filepath.Join(h.subtitlePath, videoHash(path)), r.URL.Query().Get("id"))
	if err != nil {
		switch {
		case os.IsExist(err):
			jsonError(w, "같은 이름의 자막이 있습니다. 현재 자막을 휴지통으로 옮긴 뒤 복구해 주세요.", http.StatusConflict)
		case os.IsNotExist(err):
			jsonError(w, "휴지통에서 자막을 찾지 못했습니다", http.StatusNotFound)
		case os.IsPermission(err):
			jsonError(w, "잘못된 휴지통 항목입니다", http.StatusBadRequest)
		default:
			jsonError(w, "자막을 복구하지 못했습니다", http.StatusInternalServerError)
		}
		return
	}
	h.logSubtitleOp(r, "subtitle_restore", path, entry.Filename)
	jsonResponse(w, map[string]string{"id": "generated:" + entry.Filename}, http.StatusOK)
}
