package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func datedTrash(t *testing.T, root, key string, deleted time.Time) TrashedSubtitle {
	t.Helper()
	dir := filepath.Join(root, key)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.vtt"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	entry, err := TrashSubtitle(dir, "a.vtt", "label", key+".mkv")
	if err != nil {
		t.Fatal(err)
	}
	entry.DeletedAt = deleted
	data, _ := json.Marshal(entry)
	if err := os.WriteFile(filepath.Join(dir, ".trash", entry.ID, "metadata.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestGlobalTrashRetention(t *testing.T) {
	for _, days := range []int{0, 7, 15, 30, -1, 1} {
		t.Run(time.Duration(days).String(), func(t *testing.T) {
			root := t.TempDir()
			now := time.Now().UTC()
			datedTrash(t, root, "0000000000000001", now.Add(-31*24*time.Hour))
			datedTrash(t, root, "0000000000000002", now.Add(-16*24*time.Hour))
			datedTrash(t, root, "0000000000000003", now.Add(-8*24*time.Hour))
			datedTrash(t, root, "0000000000000004", now)
			datedTrash(t, root, "0000000000000005", time.Time{})
			datedTrash(t, root, "0000000000000006", now.Add(time.Hour))
			expected := map[int]int{7: 3, 15: 2, 30: 1}[days]
			count, err := PurgeExpiredSubtitleTrash(root, days, now)
			if err != nil || count != expected {
				t.Fatal(count, err)
			}
			entries, err := ListAllSubtitleTrash(root)
			if err != nil || len(entries) != 6-expected {
				t.Fatal(entries, err)
			}
			for _, entry := range entries {
				if entry.StorageKey == "" || entry.VideoPath == "" {
					t.Fatal(entry)
				}
			}
		})
	}
}

func TestGlobalTrashNeverFollowsLinksOrDeletesActiveFiles(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	now := time.Now().UTC()
	entry := datedTrash(t, root, "0000000000000001", now.Add(-7*24*time.Hour))
	dir := filepath.Join(root, "0000000000000001")
	os.WriteFile(filepath.Join(dir, "a.vtt"), []byte("new"), 0600)
	os.Mkdir(filepath.Join(dir, ".history"), 0700)
	os.WriteFile(filepath.Join(dir, ".history", "keep.vtt"), []byte("history"), 0600)
	datedTrash(t, outside, "0000000000000002", now.Add(-40*24*time.Hour))
	os.Symlink(filepath.Join(outside, "0000000000000002"), filepath.Join(root, "0000000000000002"))
	count, err := PurgeExpiredSubtitleTrash(root, 7, now)
	if count != 1 || err != nil {
		t.Fatal(count, err)
	}
	if _, err := RestoreSubtitle(dir, entry.ID); !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(dir, "a.vtt"), filepath.Join(dir, ".history", "keep.vtt")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal(err)
		}
	}
	remaining, _ := ListAllSubtitleTrash(outside)
	if len(remaining) != 1 {
		t.Fatal(remaining)
	}
	for _, key := range []string{"../", "123", "ABCDEF0123456789", "0000000000000001/.."} {
		if ValidSubtitleStorageKey(key) {
			t.Fatal(key)
		}
	}
}

func TestGlobalTrashRestoreRacesExpiry(t *testing.T) {
	for i := 0; i < 20; i++ {
		root := t.TempDir()
		now := time.Now().UTC()
		entry := datedTrash(t, root, "0000000000000001", now.Add(-8*24*time.Hour))
		dir := filepath.Join(root, "0000000000000001")
		var wg sync.WaitGroup
		var restoreErr, purgeErr error
		var count int
		wg.Add(2)
		go func() { defer wg.Done(); _, restoreErr = RestoreSubtitle(dir, entry.ID) }()
		go func() { defer wg.Done(); count, purgeErr = PurgeExpiredSubtitleTrash(root, 7, now) }()
		wg.Wait()
		if purgeErr != nil {
			t.Fatal(purgeErr)
		}
		if restoreErr == nil {
			data, err := os.ReadFile(filepath.Join(dir, "a.vtt"))
			if count != 0 || err != nil || string(data) != "original" {
				t.Fatal(count, err)
			}
		} else if !os.IsNotExist(restoreErr) || count != 1 {
			t.Fatal(restoreErr, count)
		}
	}
}
