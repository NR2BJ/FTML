package handlers

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/job"
	"github.com/video-stream/backend/internal/storage"
)

type SubtitleHandler struct {
	mediaPath    string
	subtitlePath string
	jobQueue     *job.JobQueue
}

func NewSubtitleHandler(mediaPath, subtitlePath string, jobQueue *job.JobQueue) *SubtitleHandler {
	// Ensure subtitle output directory exists
	os.MkdirAll(subtitlePath, 0755)
	return &SubtitleHandler{
		mediaPath:    mediaPath,
		subtitlePath: subtitlePath,
		jobQueue:     jobQueue,
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
	if params.Engine == "" {
		params.Engine = "whisper.cpp"
	}
	if params.Model == "" {
		params.Model = "large-v3"
	}
	if params.Language == "" {
		params.Language = "auto"
	}

	j, err := h.jobQueue.Enqueue(job.JobTranscribe, path, params)
	if err != nil {
		jsonError(w, "failed to create job: "+err.Error(), http.StatusInternalServerError)
		return
	}

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

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"job_id": j.ID,
	})
}
