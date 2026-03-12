package storage

import (
	"os"
	"path/filepath"
	"strings"
)

type FileEntry struct {
	Name     string       `json:"name"`
	Path     string       `json:"path"`
	IsDir    bool         `json:"is_dir"`
	Size     int64        `json:"size,omitempty"`
	Children []*FileEntry `json:"children,omitempty"`
}

var videoExtensions = map[string]bool{
	".mp4": true, ".mkv": true, ".avi": true, ".mov": true,
	".wmv": true, ".flv": true, ".webm": true, ".m4v": true,
	".ts": true, ".mpg": true, ".mpeg": true,
}

var subtitleExtensions = map[string]bool{
	".srt": true, ".vtt": true, ".ass": true, ".ssa": true, ".sub": true,
}

func IsVideoFile(name string) bool {
	return videoExtensions[strings.ToLower(filepath.Ext(name))]
}

func IsSubtitleFile(name string) bool {
	return subtitleExtensions[strings.ToLower(filepath.Ext(name))]
}

func ListDirectory(basePath, relativePath string) ([]*FileEntry, error) {
	fullPath, err := ResolveWithinBase(basePath, relativePath)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return nil, err
	}

	var result []*FileEntry
	for _, entry := range entries {
		// Skip hidden files
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}

		fe := &FileEntry{
			Name:  entry.Name(),
			Path:  filepath.Join(relativePath, entry.Name()),
			IsDir: entry.IsDir(),
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				continue
			}
			fe.Size = info.Size()
		}
		result = append(result, fe)
	}
	return result, nil
}
