package storage

import (
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const searchIndexTTL = 2 * time.Minute

type indexedEntry struct {
	entry     FileEntry
	nameLower string
}

type searchIndexSnapshot struct {
	entries   []indexedEntry
	expiresAt time.Time
}

type searchIndexBuild struct {
	done    chan struct{}
	entries []indexedEntry
	err     error
}

var (
	searchIndexMu     sync.Mutex
	searchIndexCache  = make(map[string]searchIndexSnapshot)
	searchIndexBuilds = make(map[string]*searchIndexBuild)
)

func Search(basePath, query string, maxResults int) ([]*FileEntry, error) {
	query = strings.ToLower(strings.TrimSpace(query))

	entries, err := getSearchIndex(basePath)
	if err != nil {
		return nil, err
	}

	results := make([]*FileEntry, 0, maxResults)
	for _, item := range entries {
		if !strings.Contains(item.nameLower, query) {
			continue
		}
		entry := item.entry
		results = append(results, &entry)
		if len(results) >= maxResults {
			break
		}
	}

	return results, nil
}

func getSearchIndex(basePath string) ([]indexedEntry, error) {
	now := time.Now()

	searchIndexMu.Lock()
	if cached, ok := searchIndexCache[basePath]; ok && now.Before(cached.expiresAt) {
		searchIndexMu.Unlock()
		return cached.entries, nil
	}
	if build, ok := searchIndexBuilds[basePath]; ok {
		searchIndexMu.Unlock()
		<-build.done
		return build.entries, build.err
	}

	build := &searchIndexBuild{done: make(chan struct{})}
	searchIndexBuilds[basePath] = build
	searchIndexMu.Unlock()

	entries, err := buildSearchIndex(basePath)

	searchIndexMu.Lock()
	delete(searchIndexBuilds, basePath)
	if err == nil {
		searchIndexCache[basePath] = searchIndexSnapshot{
			entries:   entries,
			expiresAt: time.Now().Add(searchIndexTTL),
		}
	}
	build.entries = entries
	build.err = err
	close(build.done)
	searchIndexMu.Unlock()

	return entries, err
}

func buildSearchIndex(basePath string) ([]indexedEntry, error) {
	entries := make([]indexedEntry, 0, 1024)

	err := filepath.WalkDir(basePath, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}

		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		rel, err := filepath.Rel(basePath, path)
		if err != nil || rel == "." {
			return nil
		}

		indexed := indexedEntry{
			entry: FileEntry{
				Name:  name,
				Path:  rel,
				IsDir: entry.IsDir(),
			},
			nameLower: strings.ToLower(name),
		}
		if !entry.IsDir() {
			info, err := entry.Info()
			if err == nil {
				indexed.entry.Size = info.Size()
			}
		}
		entries = append(entries, indexed)
		return nil
	})

	return entries, err
}
