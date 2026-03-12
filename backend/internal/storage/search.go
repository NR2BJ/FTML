package storage

import (
	"io/fs"
	"path/filepath"
	"strings"
)

func Search(basePath, query string, maxResults int) ([]*FileEntry, error) {
	query = strings.ToLower(strings.TrimSpace(query))
	var results []*FileEntry

	err := filepath.WalkDir(basePath, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if len(results) >= maxResults {
			return filepath.SkipAll
		}

		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.Contains(strings.ToLower(name), query) {
			return nil
		}

		rel, err := filepath.Rel(basePath, path)
		if err != nil {
			return nil
		}

		result := &FileEntry{
			Name:  name,
			Path:  rel,
			IsDir: entry.IsDir(),
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err == nil {
				result.Size = info.Size()
			}
		}
		results = append(results, result)
		return nil
	})
	return results, err
}
