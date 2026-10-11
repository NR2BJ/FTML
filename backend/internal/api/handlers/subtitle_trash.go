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
	h.restoreSubtitle(w, r, videoHash(path), path)
}

func (h *SubtitleHandler) RestoreGlobalSubtitle(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("storage_key")
	if !storage.ValidSubtitleStorageKey(key) {
		jsonError(w, "잘못된 휴지통 항목입니다", http.StatusBadRequest)
		return
	}
	h.restoreSubtitle(w, r, key, h.trashVideoPaths(r)[key])
}

func (h *SubtitleHandler) restoreSubtitle(w http.ResponseWriter, r *http.Request, key, path string) {
	entry, err := storage.RestoreSubtitle(filepath.Join(h.subtitlePath, key), r.URL.Query().Get("id"))
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
	if entry.VideoPath != "" {
		path = entry.VideoPath
	}
	h.logSubtitleOp(r, "subtitle_restore", path, entry.Filename)
	jsonResponse(w, map[string]string{"id": "generated:" + entry.Filename, "video_path": path}, http.StatusOK)
}

func (h *SubtitleHandler) ListAllSubtitleTrash(w http.ResponseWriter, r *http.Request) {
	entries, err := storage.ListAllSubtitleTrash(h.subtitlePath)
	if err != nil {
		jsonError(w, "휴지통 목록을 읽지 못했습니다", http.StatusInternalServerError)
		return
	}
	paths := h.trashVideoPaths(r)
	for i := range entries {
		if entries[i].VideoPath == "" {
			entries[i].VideoPath = paths[entries[i].StorageKey]
		}
	}
	jsonResponse(w, entries, http.StatusOK)
}

// 이전 버전의 메타데이터에는 영상 경로가 없으므로 삭제 기록으로 보완한다.
func (h *SubtitleHandler) trashVideoPaths(r *http.Request) map[string]string {
	paths := map[string]string{}
	if h.database != nil {
		rows, err := h.database.DB().QueryContext(r.Context(), "SELECT DISTINCT file_path FROM file_logs WHERE action = 'subtitle_trash'")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var path string
				if rows.Scan(&path) == nil {
					paths[videoHash(path)] = path
				}
			}
		}
	}
	return paths
}
