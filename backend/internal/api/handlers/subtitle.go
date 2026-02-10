package handlers

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/job"
	"github.com/video-stream/backend/internal/storage"
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
	fullPath := filepath.Join(h.mediaPath, path)

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	var entries []SubtitleEntry

	// 1. Find embedded subtitles via FFprobe
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
			if !strings.HasPrefix(subBase, videoBase) {
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
			if ext != ".vtt" && ext != ".srt" {
				continue
			}

			label := name
			lang := ""
			// Parse generated subtitle filenames: whisper_ja.vtt, translate_ko_gemini.vtt
			baseName := strings.TrimSuffix(name, ext)
			if strings.HasPrefix(baseName, "whisper_") {
				lang = strings.TrimPrefix(baseName, "whisper_")
				label = fmt.Sprintf("Generated (%s)", lang)
			} else if strings.HasPrefix(baseName, "translate_") {
				parts := strings.SplitN(strings.TrimPrefix(baseName, "translate_"), "_", 2)
				if len(parts) == 2 {
					lang = parts[0]
					label = fmt.Sprintf("Translated %s (%s)", lang, parts[1])
				}
			}

			entries = append(entries, SubtitleEntry{
				ID:       "generated:" + name,
				Label:    label,
				Language: lang,
				Type:     "generated",
				Format:   strings.TrimPrefix(ext, "."),
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}

// ServeSubtitle serves a subtitle as WebVTT format
func (h *SubtitleHandler) ServeSubtitle(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	subtitleID := r.URL.Query().Get("id")

	if subtitleID == "" {
		jsonError(w, "subtitle id required", http.StatusBadRequest)
		return
	}

	fullPath := filepath.Join(h.mediaPath, path)

	if strings.HasPrefix(subtitleID, "embedded:") {
		h.serveEmbeddedSubtitle(w, fullPath, subtitleID)
	} else if strings.HasPrefix(subtitleID, "external:") {
		h.serveExternalSubtitle(w, fullPath, subtitleID)
	} else if strings.HasPrefix(subtitleID, "generated:") {
		h.serveGeneratedSubtitle(w, path, subtitleID)
	} else {
		jsonError(w, "invalid subtitle id", http.StatusBadRequest)
	}
}

func (h *SubtitleHandler) serveEmbeddedSubtitle(w http.ResponseWriter, videoPath, subtitleID string) {
	// Parse stream index from "embedded:3"
	var streamIndex int
	fmt.Sscanf(strings.TrimPrefix(subtitleID, "embedded:"), "%d", &streamIndex)

	// Extract subtitle as VTT using FFmpeg
	cmd := exec.Command("ffmpeg",
		"-hide_banner",
		"-loglevel", "error",
		"-i", videoPath,
		"-map", fmt.Sprintf("0:%d", streamIndex),
		"-f", "webvtt",
		"pipe:1",
	)

	output, err := cmd.Output()
	if err != nil {
		jsonError(w, "failed to extract subtitle", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "max-age=3600")
	w.Write(output)
}

func (h *SubtitleHandler) serveExternalSubtitle(w http.ResponseWriter, videoPath, subtitleID string) {
	filename := strings.TrimPrefix(subtitleID, "external:")
	videoDir := filepath.Dir(videoPath)
	subPath := filepath.Join(videoDir, filename)

	// Security: ensure the subtitle file is in the same directory
	absDir, _ := filepath.Abs(videoDir)
	absSub, _ := filepath.Abs(subPath)
	if !strings.HasPrefix(absSub, absDir) {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

	data, err := os.ReadFile(subPath)
	if err != nil {
		jsonError(w, "subtitle file not found", http.StatusNotFound)
		return
	}

	ext := strings.ToLower(filepath.Ext(filename))

	w.Header().Set("Cache-Control", "max-age=3600")

	switch ext {
	case ".vtt":
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		w.Write(data)
	case ".srt":
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		w.Write(srtToVTT(data))
	case ".ass", ".ssa":
		// Use FFmpeg to convert ASS/SSA to VTT
		cmd := exec.Command("ffmpeg",
			"-hide_banner",
			"-loglevel", "error",
			"-i", subPath,
			"-f", "webvtt",
			"pipe:1",
		)
		output, err := cmd.Output()
		if err != nil {
			// Fallback: serve as-is
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Write(data)
			return
		}
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		w.Write(output)
	default:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(data)
	}
}

// srtToVTT converts SRT subtitle format to WebVTT
func srtToVTT(srtData []byte) []byte {
	var buf bytes.Buffer
	buf.WriteString("WEBVTT\n\n")

	// Replace \r\n with \n
	content := strings.ReplaceAll(string(srtData), "\r\n", "\n")

	scanner := bufio.NewScanner(strings.NewReader(content))
	timestampRe := regexp.MustCompile(`(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})`)

	for scanner.Scan() {
		line := scanner.Text()
		// Convert SRT timestamp commas to VTT dots
		if timestampRe.MatchString(line) {
			line = timestampRe.ReplaceAllString(line, "$1.$2 --> $3.$4")
		}
		buf.WriteString(line)
		buf.WriteString("\n")
	}

	return buf.Bytes()
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

func (h *SubtitleHandler) serveGeneratedSubtitle(w http.ResponseWriter, videoPath, subtitleID string) {
	filename := strings.TrimPrefix(subtitleID, "generated:")
	hash := videoHash(videoPath)
	subPath := filepath.Join(h.subtitlePath, hash, filename)

	// Security: ensure file is within subtitle directory
	absBase, _ := filepath.Abs(h.subtitlePath)
	absSub, _ := filepath.Abs(subPath)
	if !strings.HasPrefix(absSub, absBase) {
		jsonError(w, "invalid path", http.StatusForbidden)
		return
	}

	data, err := os.ReadFile(subPath)
	if err != nil {
		jsonError(w, "subtitle file not found", http.StatusNotFound)
		return
	}

	ext := strings.ToLower(filepath.Ext(filename))

	w.Header().Set("Cache-Control", "max-age=3600")

	switch ext {
	case ".vtt":
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		w.Write(data)
	case ".srt":
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		w.Write(srtToVTT(data))
	default:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(data)
	}
}

// GenerateSubtitle creates a transcription job
func (h *SubtitleHandler) GenerateSubtitle(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath := filepath.Join(h.mediaPath, path)

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	var params job.TranscribeParams
	if err := json.NewDecoder(r.Body).Decode(&params); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Defaults
	if params.Language == "" {
		params.Language = "auto"
	}

	j, err := h.jobQueue.Enqueue(job.JobTranscribe, path, params)
	if err != nil {
		jsonError(w, "failed to create job: "+err.Error(), http.StatusInternalServerError)
		return
	}

	h.logSubtitleOp(r, "subtitle_generate", path, params.Language)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"job_id": j.ID,
	})
}

// TranslateSubtitle creates a translation job
func (h *SubtitleHandler) TranslateSubtitle(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath := filepath.Join(h.mediaPath, path)

	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	var params job.TranslateParams
	if err := json.NewDecoder(r.Body).Decode(&params); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if params.SubtitleID == "" {
		jsonError(w, "subtitle_id required", http.StatusBadRequest)
		return
	}
	if params.TargetLang == "" {
		jsonError(w, "target_lang required", http.StatusBadRequest)
		return
	}
	if params.Engine == "" {
		params.Engine = "gemini"
	}
	if params.Preset == "" {
		params.Preset = "movie"
	}

	j, err := h.jobQueue.Enqueue(job.JobTranslate, path, params)
	if err != nil {
		jsonError(w, "failed to create job: "+err.Error(), http.StatusInternalServerError)
		return
	}

	h.logSubtitleOp(r, "subtitle_translate", path, params.TargetLang)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"job_id": j.ID,
	})
}

// BatchGenerate creates transcription jobs for multiple files
func (h *SubtitleHandler) BatchGenerate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths    []string `json:"paths"`
		Engine   string   `json:"engine"`
		Model    string   `json:"model"`
		Language string   `json:"language"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if len(req.Paths) == 0 {
		jsonError(w, "paths required", http.StatusBadRequest)
		return
	}

	// Defaults
	if req.Language == "" {
		req.Language = "auto"
	}

	var jobIDs []string
	var skipped []string

	for _, path := range req.Paths {
		fullPath := filepath.Join(h.mediaPath, path)
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			skipped = append(skipped, path)
			continue
		}

		params := job.TranscribeParams{
			Engine:   req.Engine,
			Model:    req.Model,
			Language: req.Language,
		}

		j, err := h.jobQueue.Enqueue(job.JobTranscribe, path, params)
		if err != nil {
			skipped = append(skipped, path)
			continue
		}
		jobIDs = append(jobIDs, j.ID)
		h.logSubtitleOp(r, "subtitle_generate", path, req.Language)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"job_ids": jobIDs,
		"skipped": skipped,
	})
}

// BatchTranslate creates translation jobs for multiple files
func (h *SubtitleHandler) BatchTranslate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths        []string `json:"paths"`
		TargetLang   string   `json:"target_lang"`
		Engine       string   `json:"engine"`
		Preset       string   `json:"preset"`
		CustomPrompt string   `json:"custom_prompt,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if len(req.Paths) == 0 {
		jsonError(w, "paths required", http.StatusBadRequest)
		return
	}
	if req.TargetLang == "" {
		jsonError(w, "target_lang required", http.StatusBadRequest)
		return
	}
	if req.Engine == "" {
		req.Engine = "gemini"
	}
	if req.Preset == "" {
		req.Preset = "movie"
	}

	var jobIDs []string
	var skipped []string

	for _, path := range req.Paths {
		// Find the first generated subtitle for this file
		hash := videoHash(path)
		genDir := filepath.Join(h.subtitlePath, hash)
		subtitleID := ""

		genEntries, err := os.ReadDir(genDir)
		if err == nil {
			for _, entry := range genEntries {
				name := entry.Name()
				if strings.HasPrefix(name, "whisper_") && strings.HasSuffix(name, ".vtt") {
					subtitleID = "generated:" + name
					break
				}
			}
			// Also try translate files as source
			if subtitleID == "" {
				for _, entry := range genEntries {
					name := entry.Name()
					if strings.HasSuffix(name, ".vtt") {
						subtitleID = "generated:" + name
						break
					}
				}
			}
		}

		// Fallback: try embedded text subtitles
		if subtitleID == "" {
			fullPath := filepath.Join(h.mediaPath, path)
			info, probeErr := ffmpeg.Probe(fullPath)
			if probeErr == nil {
				for _, s := range info.Streams {
					if s.CodecType == "subtitle" && textSubtitleCodecs[s.CodecName] {
						subtitleID = fmt.Sprintf("embedded:%d", s.Index)
						break
					}
				}
			}
		}

		// Fallback: try external subtitle files
		if subtitleID == "" {
			fullPath := filepath.Join(h.mediaPath, path)
			videoDir := filepath.Dir(fullPath)
			videoBase := strings.TrimSuffix(filepath.Base(fullPath), filepath.Ext(fullPath))
			dirEntries, readErr := os.ReadDir(videoDir)
			if readErr == nil {
				for _, entry := range dirEntries {
					if entry.IsDir() {
						continue
					}
					name := entry.Name()
					if !storage.IsSubtitleFile(name) {
						continue
					}
					subBase := strings.TrimSuffix(name, filepath.Ext(name))
					if strings.HasPrefix(subBase, videoBase) {
						subtitleID = "external:" + name
						break
					}
				}
			}
		}

		if subtitleID == "" {
			skipped = append(skipped, path)
			continue
		}

		params := job.TranslateParams{
			SubtitleID:   subtitleID,
			TargetLang:   req.TargetLang,
			Engine:       req.Engine,
			Preset:       req.Preset,
			CustomPrompt: req.CustomPrompt,
		}

		j, err := h.jobQueue.Enqueue(job.JobTranslate, path, params)
		if err != nil {
			skipped = append(skipped, path)
			continue
		}
		jobIDs = append(jobIDs, j.ID)
		h.logSubtitleOp(r, "subtitle_translate", path, req.TargetLang)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"job_ids": jobIDs,
		"skipped": skipped,
	})
}

// BatchGenerateTranslate creates transcription jobs with chained translation for multiple files
func (h *SubtitleHandler) BatchGenerateTranslate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths      []string `json:"paths"`
		Engine     string   `json:"engine"`
		Model      string   `json:"model"`
		Language   string   `json:"language"`
		Translate  struct {
			TargetLang   string `json:"target_lang"`
			Engine       string `json:"engine"`
			Preset       string `json:"preset"`
			CustomPrompt string `json:"custom_prompt,omitempty"`
		} `json:"translate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if len(req.Paths) == 0 {
		jsonError(w, "paths required", http.StatusBadRequest)
		return
	}
	if req.Translate.TargetLang == "" {
		jsonError(w, "translate.target_lang required", http.StatusBadRequest)
		return
	}

	// Defaults
	if req.Language == "" {
		req.Language = "auto"
	}
	if req.Translate.Engine == "" {
		req.Translate.Engine = "gemini"
	}
	if req.Translate.Preset == "" {
		req.Translate.Preset = "movie"
	}

	var jobIDs []string
	var skipped []string

	for _, path := range req.Paths {
		fullPath := filepath.Join(h.mediaPath, path)
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			skipped = append(skipped, path)
			continue
		}

		params := job.TranscribeParams{
			Engine:   req.Engine,
			Model:    req.Model,
			Language: req.Language,
			ChainTranslate: &job.TranslateParams{
				TargetLang:   req.Translate.TargetLang,
				Engine:       req.Translate.Engine,
				Preset:       req.Translate.Preset,
				CustomPrompt: req.Translate.CustomPrompt,
			},
		}

		j, err := h.jobQueue.Enqueue(job.JobTranscribe, path, params)
		if err != nil {
			skipped = append(skipped, path)
			continue
		}
		jobIDs = append(jobIDs, j.ID)
		h.logSubtitleOp(r, "subtitle_generate_translate", path, req.Language)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"job_ids": jobIDs,
		"skipped": skipped,
	})
}

// UploadSubtitle allows uploading an external subtitle file (User+ only)
// POST /subtitle/upload/* — multipart/form-data with "file" field
func (h *SubtitleHandler) UploadSubtitle(w http.ResponseWriter, r *http.Request) {
	path := extractPath(r)
	fullPath := filepath.Join(h.mediaPath, path)

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
	ext := strings.ToLower(filepath.Ext(filename))
	allowedExts := map[string]bool{".srt": true, ".vtt": true, ".ass": true, ".ssa": true}
	if !allowedExts[ext] {
		jsonError(w, "only .srt, .vtt, .ass, .ssa files are allowed", http.StatusBadRequest)
		return
	}

	// Validate filename (no path traversal)
	if strings.ContainsAny(filename, "/\\") || strings.Contains(filename, "..") {
		jsonError(w, "invalid filename", http.StatusBadRequest)
		return
	}

	// Save to generated subtitles directory
	hash := videoHash(path)
	genDir := filepath.Join(h.subtitlePath, hash)
	os.MkdirAll(genDir, 0755)

	destPath := filepath.Join(genDir, filename)

	dst, err := os.Create(destPath)
	if err != nil {
		jsonError(w, "failed to save subtitle", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		os.Remove(destPath)
		jsonError(w, "failed to write subtitle", http.StatusInternalServerError)
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
	if strings.ContainsAny(filename, "/\\") || strings.Contains(filename, "..") {
		jsonError(w, "invalid subtitle id", http.StatusBadRequest)
		return
	}

	hash := videoHash(path)
	subPath := filepath.Join(h.subtitlePath, hash, filename)

	// Security: ensure the resolved path is within the subtitle directory
	absBase, _ := filepath.Abs(h.subtitlePath)
	absSub, _ := filepath.Abs(subPath)
	if !strings.HasPrefix(absSub, absBase) {
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

	// Find the subtitle file
	subDir := filepath.Join(h.subtitlePath, videoPath)
	entries, err := filepath.Glob(filepath.Join(subDir, req.SubtitleID+".*"))
	if err != nil || len(entries) == 0 {
		// Also check embedded subtitle references
		jsonError(w, "subtitle not found", http.StatusNotFound)
		return
	}

	srcPath := entries[0]
	srcExt := strings.TrimPrefix(strings.ToLower(filepath.Ext(srcPath)), ".")

	// If source format is the same as target, just serve the file
	if srcExt == targetFmt {
		data, err := os.ReadFile(srcPath)
		if err != nil {
			jsonError(w, "failed to read subtitle", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		baseName := strings.TrimSuffix(filepath.Base(srcPath), filepath.Ext(srcPath))
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.%s\"", baseName, targetFmt))
		w.Write(data)
		return
	}

	// SRT → VTT (Go conversion)
	if srcExt == "srt" && targetFmt == "vtt" {
		data, err := os.ReadFile(srcPath)
		if err != nil {
			jsonError(w, "failed to read subtitle", http.StatusInternalServerError)
			return
		}
		converted := srtToVTT(data)
		baseName := strings.TrimSuffix(filepath.Base(srcPath), filepath.Ext(srcPath))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.vtt\"", baseName))
		w.Write(converted)
		return
	}

	// VTT → SRT (Go conversion)
	if srcExt == "vtt" && targetFmt == "srt" {
		data, err := os.ReadFile(srcPath)
		if err != nil {
			jsonError(w, "failed to read subtitle", http.StatusInternalServerError)
			return
		}
		converted := vttToSRT(data)
		baseName := strings.TrimSuffix(filepath.Base(srcPath), filepath.Ext(srcPath))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.srt\"", baseName))
		w.Write(converted)
		return
	}

	// For ASS conversions, use FFmpeg
	var outputData []byte
	cmd := exec.Command("ffmpeg",
		"-i", srcPath,
		"-f", targetFmt,
		"-",
	)
	outputData, err = cmd.Output()
	if err != nil {
		jsonError(w, "conversion failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	h.logSubtitleOp(r, "subtitle_convert", videoPath, targetFmt)

	baseName := strings.TrimSuffix(filepath.Base(srcPath), filepath.Ext(srcPath))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.%s\"", baseName, targetFmt))
	w.Write(outputData)
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

// vttToSRT converts WebVTT to SRT format
func vttToSRT(vttData []byte) []byte {
	var buf bytes.Buffer
	content := strings.ReplaceAll(string(vttData), "\r\n", "\n")

	// Skip WEBVTT header
	lines := strings.Split(content, "\n")
	cueIndex := 1
	i := 0
	// Skip header lines
	for i < len(lines) {
		if strings.TrimSpace(lines[i]) == "" {
			i++
			break
		}
		i++
	}

	timestampRe := regexp.MustCompile(`(\d{2}:\d{2}:\d{2})\.(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2})\.(\d{3})`)

	for i < len(lines) {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			i++
			continue
		}

		// Check if this is a timestamp line
		if timestampRe.MatchString(line) {
			buf.WriteString(fmt.Sprintf("%d\n", cueIndex))
			cueIndex++
			// Convert VTT dots to SRT commas
			line = timestampRe.ReplaceAllString(line, "$1,$2 --> $3,$4")
			buf.WriteString(line + "\n")
			i++
			// Read text lines until empty line
			for i < len(lines) && strings.TrimSpace(lines[i]) != "" {
				buf.WriteString(lines[i] + "\n")
				i++
			}
			buf.WriteString("\n")
		} else {
			// Skip cue identifiers or other non-timestamp lines
			i++
		}
	}

	return buf.Bytes()
}
