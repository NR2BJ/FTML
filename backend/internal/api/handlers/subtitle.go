package handlers

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/job"
	"github.com/video-stream/backend/internal/storage"
	"github.com/video-stream/backend/internal/subtitle"
)

type SubtitleHandler struct {
	mediaPath    string
	subtitlePath string
	jobQueue     *job.JobQueue
	database     *db.Database
}

func NewSubtitleHandler(mediaPath, subtitlePath string, jobQueue *job.JobQueue, database *db.Database) *SubtitleHandler {
	// Ensure subtitle output directory exists
	os.MkdirAll(subtitlePath, 0755)
	return &SubtitleHandler{
		mediaPath:    mediaPath,
		subtitlePath: subtitlePath,
		jobQueue:     jobQueue,
		database:     database,
	}
}

// logSubtitleOp logs subtitle operations to the file_logs table
func (h *SubtitleHandler) logSubtitleOp(r *http.Request, action, path, detail string) {
	claims := middleware.GetClaims(r)
	if claims != nil && h.database != nil {
		h.database.CreateFileLog(claims.UserID, claims.Username, action, path, detail)
	}
}

// videoHash returns a short hash of the video path for subtitle storage
func videoHash(videoPath string) string {
	h := sha256.Sum256([]byte(videoPath))
	return fmt.Sprintf("%x", h[:8])
}

func isSimpleFilename(name string) bool {
	return name == filepath.Base(name) && name != "." && name != ".."
}

func (h *SubtitleHandler) safeVideoPath(relPath string) (string, bool) {
	fullPath, err := storage.ResolveWithinBase(h.mediaPath, relPath)
	if err != nil {
		return "", false
	}
	return fullPath, true
}

func (h *SubtitleHandler) safeGeneratedSubtitlePath(videoPath, filename string) (string, bool) {
	if !isSimpleFilename(filename) {
		return "", false
	}
	fullPath, err := storage.ResolveWithinBase(h.subtitlePath, filepath.Join(videoHash(videoPath), filename))
	if err != nil {
		return "", false
	}
	return fullPath, true
}

func (h *SubtitleHandler) safeSiblingSubtitlePath(videoFullPath, filename string) (string, bool) {
	if !isSimpleFilename(filename) {
		return "", false
	}
	fullPath, err := storage.ResolveWithinBase(filepath.Dir(videoFullPath), filename)
	if err != nil {
		return "", false
	}
	return fullPath, true
}

type SubtitleEntry struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Language string `json:"language"`
	Type     string `json:"type"`   // "embedded" or "external"
	Format   string `json:"format"` // codec name or file extension
}

// textSubtitleCodecs are subtitle codecs that can be converted to VTT
var textSubtitleCodecs = map[string]bool{
	"subrip":     true, // SRT
	"ass":        true,
	"ssa":        true,
	"webvtt":     true,
	"mov_text":   true, // MP4 embedded text
	"srt":        true,
	"text":       true,
	"substation": true,
}

// ListSubtitles returns available subtitles (embedded + external) for a video
func (h *SubtitleHandler) ListSubtitles(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath, ok := h.safeVideoPath(path)
	if !ok {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	entries := h.subtitleEntries(path, fullPath, true)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}

func embeddedSubtitleEntries(fullPath string) []SubtitleEntry {
	entries := make([]SubtitleEntry, 0)
	info, err := ffmpeg.Probe(fullPath)
	if err == nil {
		for _, s := range info.Streams {
			if s.CodecType != "subtitle" {
				continue
			}
			// Only include text-based subtitle codecs
			if !textSubtitleCodecs[s.CodecName] {
				continue
			}

			lang := "Unknown"
			if s.Tags != nil {
				if l, ok := s.Tags["language"]; ok && l != "" {
					lang = l
				}
				if title, ok := s.Tags["title"]; ok && title != "" {
					lang = title
				}
			}

			entries = append(entries, SubtitleEntry{
				ID:       fmt.Sprintf("embedded:%d", s.Index),
				Label:    lang,
				Language: langFromTags(s.Tags),
				Type:     "embedded",
				Format:   s.CodecName,
			})
		}
	}
	return entries
}

func (h *SubtitleHandler) subtitleEntries(path, fullPath string, includeEmbedded bool) []SubtitleEntry {
	entries := make([]SubtitleEntry, 0)
	if includeEmbedded {
		entries = embeddedSubtitleEntries(fullPath)
	}

	// 2. Find external subtitle files in the same directory
	videoDir := filepath.Dir(fullPath)
	videoBase := strings.TrimSuffix(filepath.Base(fullPath), filepath.Ext(fullPath))

	dirEntries, err := os.ReadDir(videoDir)
	if err == nil {
		for _, entry := range dirEntries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if !storage.IsSubtitleFile(name) {
				continue
			}
			// Match subtitle files that start with the video filename
			subBase := strings.TrimSuffix(name, filepath.Ext(name))
			if subBase != videoBase && !strings.HasPrefix(subBase, videoBase+".") {
				continue
			}

			// Extract language hint from filename
			// e.g., "video.ko.srt" -> "ko", "video.en.ass" -> "en"
			label := name
			lang := ""
			suffix := strings.TrimPrefix(subBase, videoBase)
			suffix = strings.TrimPrefix(suffix, ".")
			if suffix != "" {
				lang = suffix
				label = suffix + " (" + filepath.Ext(name)[1:] + ")"
			}

			entries = append(entries, SubtitleEntry{
				ID:       "external:" + name,
				Label:    label,
				Language: lang,
				Type:     "external",
				Format:   strings.TrimPrefix(filepath.Ext(name), "."),
			})
		}
	}

	// 3. Find generated subtitles in subtitle output directory
	hash := videoHash(path)
	genDir := filepath.Join(h.subtitlePath, hash)
	genEntries, err := os.ReadDir(genDir)
	if err == nil {
		for _, entry := range genEntries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			ext := strings.ToLower(filepath.Ext(name))
			if !storage.IsSubtitleFile(name) {
				continue
			}

			label, lang := generatedSubtitleLabel(name)

			entries = append(entries, SubtitleEntry{
				ID:       "generated:" + name,
				Label:    label,
				Language: lang,
				Type:     "generated",
				Format:   strings.TrimPrefix(ext, "."),
			})
		}
	}

	var sources map[string]job.TranslationSource
	if h.jobQueue != nil {
		for _, entry := range entries {
			if strings.HasPrefix(entry.ID, "generated:translate_") {
				sources, _ = h.jobQueue.TranslationSources(path)
				break
			}
		}
	}
	applyTranslationLabels(entries, sources)
	return entries
}

// ServeSubtitle는 기본 일반 표시와 ASS 원형 표시를 분리한다.
func (h *SubtitleHandler) ServeSubtitle(w http.ResponseWriter, r *http.Request) {
	doc, err := subtitle.Load(r.Context(), h.mediaPath, h.subtitlePath, extractPath(r), r.URL.Query().Get("id"))
	if err != nil {
		jsonError(w, "자막을 읽을 수 없습니다", http.StatusBadRequest)
		return
	}
	data := doc.Data
	contentType := "text/vtt; charset=utf-8"
	if r.URL.Query().Get("mode") == "native" && subtitle.IsASS(doc.Format) {
		contentType = "text/x-ssa; charset=utf-8"
	} else {
		data, err = doc.VTT(r.Context())
		if err != nil {
			jsonError(w, "지원하지 않거나 손상된 자막입니다", http.StatusUnprocessableEntity)
			return
		}
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Write(data)
}

func langFromTags(tags map[string]string) string {
	if tags == nil {
		return ""
	}
	if l, ok := tags["language"]; ok {
		return l
	}
	return ""
}

// 기존 주소는 공통 실행 경로의 호환용 진입점으로 유지한다.
func (h *SubtitleHandler) GenerateSubtitle(w http.ResponseWriter, r *http.Request) {
	var params job.TranscribeParams
	if !decodeSubtitleRequest(w, r, &params) {
		return
	}
	mode := "generate"
	if params.ChainTranslate != nil {
		mode = "generate-translate"
	}
	h.submitSubtitleTasks(w, r, SubtitleTaskRequest{Paths: []string{extractPath(r)}, Mode: mode, Generate: params, Translate: params.ChainTranslate}, true)
}

func (h *SubtitleHandler) TranslateSubtitle(w http.ResponseWriter, r *http.Request) {
	var params job.TranslateParams
	if !decodeSubtitleRequest(w, r, &params) {
		return
	}
	if params.SubtitleID == "" {
		jsonError(w, "번역할 자막을 선택해 주세요", http.StatusBadRequest)
		return
	}
	h.submitSubtitleTasks(w, r, SubtitleTaskRequest{Paths: []string{extractPath(r)}, Mode: "translate", Translate: &params}, true)
}

func (h *SubtitleHandler) BatchGenerate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths []string `json:"paths"`
		job.TranscribeParams
	}
	if !decodeSubtitleRequest(w, r, &req) {
		return
	}
	h.submitSubtitleTasks(w, r, SubtitleTaskRequest{Paths: req.Paths, Mode: "generate", Generate: req.TranscribeParams}, false)
}

func (h *SubtitleHandler) BatchTranslate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths []string `json:"paths"`
		job.TranslateParams
	}
	if !decodeSubtitleRequest(w, r, &req) {
		return
	}
	h.submitSubtitleTasks(w, r, SubtitleTaskRequest{Paths: req.Paths, Mode: "translate", Translate: &req.TranslateParams}, false)
}

func (h *SubtitleHandler) BatchGenerateTranslate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths []string `json:"paths"`
		job.TranscribeParams
		Translate *job.TranslateParams `json:"translate"`
	}
	if !decodeSubtitleRequest(w, r, &req) {
		return
	}
	h.submitSubtitleTasks(w, r, SubtitleTaskRequest{Paths: req.Paths, Mode: "generate-translate", Generate: req.TranscribeParams, Translate: req.Translate}, false)
}
func (h *SubtitleHandler) UploadSubtitle(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath, ok := h.safeVideoPath(path)
	if !ok {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "video file not found", http.StatusNotFound)
		return
	}

	// Limit upload to 10MB for subtitle files
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)

	if err := r.ParseMultipartForm(10 << 20); err != nil {
		jsonError(w, "failed to parse upload", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		jsonError(w, "file field required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Validate extension
	filename := filepath.Base(header.Filename)
	if !storage.IsSubtitleFile(filename) {
		jsonError(w, "SRT, VTT, ASS, SSA, SMI 자막을 지원합니다", http.StatusBadRequest)
		return
	}

	// Validate filename (no path traversal)
	if !isSimpleFilename(filename) || strings.Contains(filename, "..") {
		jsonError(w, "invalid filename", http.StatusBadRequest)
		return
	}

	// Save to generated subtitles directory
	hash := videoHash(path)
	genDir := filepath.Join(h.subtitlePath, hash)
	os.MkdirAll(genDir, 0755)

	destPath := filepath.Join(genDir, filename)

	data, err := io.ReadAll(io.LimitReader(file, subtitle.MaxDocumentBytes+1))
	if err == nil {
		data, err = subtitle.DecodeText(data)
	}
	if err != nil || len(data) > subtitle.MaxDocumentBytes {
		jsonError(w, "UTF-8 또는 UTF-16 자막 파일을 확인해 주세요", http.StatusBadRequest)
		return
	}
	if err := storage.WriteVersionedFile(r.Context(), destPath, bytes.NewReader(data)); err != nil {
		jsonError(w, "자막 저장 실패", http.StatusInternalServerError)
		return
	}

	h.logSubtitleOp(r, "subtitle_upload", path, filename)

	jsonResponse(w, map[string]string{
		"id":       "generated:" + filename,
		"filename": filename,
	}, http.StatusCreated)
}

// DeleteSubtitle removes a generated subtitle file
func (h *SubtitleHandler) DeleteSubtitle(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	subtitleID := r.URL.Query().Get("id")

	if subtitleID == "" {
		jsonError(w, "subtitle id required", http.StatusBadRequest)
		return
	}

	// Only generated subtitles can be deleted
	if !strings.HasPrefix(subtitleID, "generated:") {
		jsonError(w, "only generated subtitles can be deleted", http.StatusForbidden)
		return
	}

	filename := strings.TrimPrefix(subtitleID, "generated:")

	// Validate filename: must not contain path separators or ".."
	if !isSimpleFilename(filename) || strings.Contains(filename, "..") {
		jsonError(w, "invalid subtitle id", http.StatusBadRequest)
		return
	}

	subPath, ok := h.safeGeneratedSubtitlePath(path, filename)
	if !ok {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

	if _, err := os.Stat(subPath); os.IsNotExist(err) {
		jsonError(w, "subtitle file not found", http.StatusNotFound)
		return
	}

	if err := os.Remove(subPath); err != nil {
		jsonError(w, "failed to delete subtitle: "+err.Error(), http.StatusInternalServerError)
		return
	}

	h.logSubtitleOp(r, "subtitle_delete", path, subtitleID)

	w.WriteHeader(http.StatusNoContent)
}

// ConvertSubtitle converts a subtitle file between formats.
// POST /subtitle/convert/*  body: { "subtitle_id": "...", "target_format": "srt|vtt|ass" }
func (h *SubtitleHandler) ConvertSubtitle(w http.ResponseWriter, r *http.Request) {
	videoPath := extractPath(r)
	if videoPath == "" {
		jsonError(w, "video path required", http.StatusBadRequest)
		return
	}

	var req struct {
		SubtitleID   string `json:"subtitle_id"`
		TargetFormat string `json:"target_format"` // "srt", "vtt", "ass"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.SubtitleID == "" || req.TargetFormat == "" {
		jsonError(w, "subtitle_id and target_format are required", http.StatusBadRequest)
		return
	}

	targetFmt := strings.ToLower(req.TargetFormat)
	if targetFmt != "srt" && targetFmt != "vtt" && targetFmt != "ass" {
		jsonError(w, "unsupported target format (srt, vtt, ass)", http.StatusBadRequest)
		return
	}

	doc, err := subtitle.Load(r.Context(), h.mediaPath, h.subtitlePath, videoPath, req.SubtitleID)
	if err != nil {
		jsonError(w, "자막 읽기 실패", http.StatusBadRequest)
		return
	}
	data, err := doc.Convert(r.Context(), targetFmt)
	if err != nil {
		jsonError(w, "자막 변환 실패", http.StatusUnprocessableEntity)
		return
	}
	_, name, _ := strings.Cut(req.SubtitleID, ":")
	name = strings.TrimSuffix(filepath.Base(name), filepath.Ext(name)) + "." + targetFmt
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Cache-Control", "private, no-cache")
	h.logSubtitleOp(r, "subtitle_convert", videoPath, targetFmt)
	w.Write(data)
}

// RequestDelete creates a delete request for a generated subtitle (user-facing)
func (h *SubtitleHandler) RequestDelete(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	if path == "" {
		jsonError(w, "missing video path", http.StatusBadRequest)
		return
	}

	var req struct {
		SubtitleID    string `json:"subtitle_id"`
		SubtitleLabel string `json:"subtitle_label"`
		Reason        string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if !strings.HasPrefix(req.SubtitleID, "generated:") {
		jsonError(w, "only generated subtitles can be requested for deletion", http.StatusBadRequest)
		return
	}
	filename := strings.TrimPrefix(req.SubtitleID, "generated:")
	if !isSimpleFilename(filename) || strings.Contains(filename, "..") {
		jsonError(w, "invalid subtitle id", http.StatusBadRequest)
		return
	}

	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	id, err := h.database.CreateDeleteRequest(claims.UserID, claims.Username, path, req.SubtitleID, req.SubtitleLabel, req.Reason)
	if err != nil {
		jsonError(w, err.Error(), http.StatusConflict)
		return
	}

	h.logSubtitleOp(r, "subtitle_delete_request", path, req.SubtitleID)
	jsonResponse(w, map[string]interface{}{"id": id, "status": "pending"}, http.StatusCreated)
}

// ListMyDeleteRequests returns the current user's delete requests
func (h *SubtitleHandler) ListMyDeleteRequests(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetClaims(r)
	if claims == nil {
		jsonError(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	requests, err := h.database.ListUserDeleteRequests(claims.UserID)
	if err != nil {
		jsonError(w, "failed to list delete requests", http.StatusInternalServerError)
		return
	}
	jsonResponse(w, requests, http.StatusOK)
}
