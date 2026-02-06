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
	fullPath := filepath.Join(basePath, relativePath)

	// Prevent path traversal
	absBase, err := filepath.Abs(basePath)
	if err != nil {
		return nil, err
	}
	absFull, err := filepath.Abs(fullPath)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(absFull, absBase) {
		return nil, os.ErrPermission
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

		info, err := entry.Info()
		if err != nil {
			continue
		}

		fe := &FileEntry{
			Name:  entry.Name(),
			Path:  filepath.Join(relativePath, entry.Name()),
			IsDir: entry.IsDir(),
		}
		if !entry.IsDir() {
			fe.Size = info.Size()
		}
		result = append(result, fe)
	}
	return result, nil
}

func BuildTree(basePath, relativePath string, depth int) (*FileEntry, error) {
	if depth <= 0 {
		entries, err := ListDirectory(basePath, relativePath)
		if err != nil {
			return nil, err
		}
		name := filepath.Base(relativePath)
		if relativePath == "" || relativePath == "." {
			name = "root"
		}
		return &FileEntry{
			Name:     name,
			Path:     relativePath,
			IsDir:    true,
			Children: entries,
		}, nil
	}

	entries, err := ListDirectory(basePath, relativePath)
	if err != nil {
		return nil, err
	}

	for _, entry := range entries {
		if entry.IsDir {
			subtree, err := BuildTree(basePath, entry.Path, depth-1)
			if err != nil {
				continue
			}
			entry.Children = subtree.Children
		}
	}

	name := filepath.Base(relativePath)
	if relativePath == "" || relativePath == "." {
		name = "root"
	}
	return &FileEntry{
		Name:     name,
		Path:     relativePath,
		IsDir:    true,
		Children: entries,
	}, nil
}
