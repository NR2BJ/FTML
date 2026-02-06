package storage

import (
	"os"
	"path/filepath"
	"strings"
)

func Search(basePath, query string, maxResults int) ([]*FileEntry, error) {
	query = strings.ToLower(query)
	var results []*FileEntry

	err := filepath.Walk(basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
		}
		if len(results) >= maxResults {
			return filepath.SkipAll
		}
		if strings.HasPrefix(info.Name(), ".") {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.Contains(strings.ToLower(info.Name()), query) {
			rel, _ := filepath.Rel(basePath, path)
			results = append(results, &FileEntry{
				Name:  info.Name(),
				Path:  rel,
				IsDir: info.IsDir(),
				Size:  info.Size(),
			})
		}
		return nil
	})
	return results, err
}
