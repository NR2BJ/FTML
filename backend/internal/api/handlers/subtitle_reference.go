package handlers

import (
	"encoding/json"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/video-stream/backend/internal/subtitle/reference"
)

func (h *SubtitleHandler) Reference(w http.ResponseWriter, r *http.Request) {
	video := path.Clean(chi.URLParam(r, "*"))
	if _, ok := h.safeVideoPath(video); !ok {
		jsonError(w, "잘못된 영상 경로", 400)
		return
	}
	if r.Method == http.MethodGet {
		jsonResponse(w, reference.Load(h.database, video), 200)
		return
	}
	var profile reference.Profile
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&profile) != nil {
		jsonError(w, "잘못된 참고 자료", 400)
		return
	}
	// 현재 영상의 상위 폴더만 수정 가능하며 다른 작품의 사전은 건드리지 않는다.
	if profile.Scope == "." || (profile.Scope != video && profile.Scope != path.Dir(video) && !strings.HasPrefix(path.Dir(video)+"/", profile.Scope+"/")) {
		jsonError(w, "이 영상의 작품 폴더만 수정할 수 있습니다", 400)
		return
	}
	if err := reference.Save(h.database, profile); err != nil {
		jsonError(w, err.Error(), 400)
		return
	}
	jsonResponse(w, profile, 200)
}
