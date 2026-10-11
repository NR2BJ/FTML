package storage

import (
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"
)

func ValidSubtitleStorageKey(key string) bool {
	decoded, err := hex.DecodeString(key)
	return err == nil && len(decoded) == 8 && hex.EncodeToString(decoded) == key
}

func ListAllSubtitleTrash(root string) ([]TrashedSubtitle, error) {
	result := []TrashedSubtitle{}
	if err := plainDirectory(root); err != nil {
		if os.IsNotExist(err) {
			return result, nil
		}
		return nil, err
	}
	dirs, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, dir := range dirs {
		if !dir.IsDir() || !ValidSubtitleStorageKey(dir.Name()) {
			continue
		}
		entries, err := ListSubtitleTrash(filepath.Join(root, dir.Name()))
		if os.IsPermission(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			entry.StorageKey = dir.Name()
			result = append(result, entry)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].DeletedAt.After(result[j].DeletedAt) })
	return result, nil
}

// 비활성/알 수 없는 설정에서는 삭제하지 않는다. 복구와 같은 잠금 아래에서
// 메타데이터를 다시 검사하여 목록 조회 이후 복구된 파일을 건드리지 않는다.
func PurgeExpiredSubtitleTrash(root string, days int, now time.Time) (int, error) {
	if days != 7 && days != 15 && days != 30 {
		return 0, nil
	}
	entries, err := ListAllSubtitleTrash(root)
	if err != nil {
		return 0, err
	}
	cutoff := now.Add(-time.Duration(days) * 24 * time.Hour)
	count := 0
	var failures error
	for _, candidate := range entries {
		if candidate.DeletedAt.IsZero() || candidate.DeletedAt.After(cutoff) {
			continue
		}
		versionedWriteMu.Lock()
		dir, err := trashDirectory(filepath.Join(root, candidate.StorageKey), false)
		if err == nil {
			entry, readErr := readTrashedSubtitle(dir, candidate.ID)
			err = readErr
			if err == nil && !entry.DeletedAt.IsZero() && !entry.DeletedAt.After(cutoff) {
				err = os.RemoveAll(filepath.Join(dir, entry.ID))
				if err == nil {
					count++
				}
			}
		}
		versionedWriteMu.Unlock()
		if err != nil && !os.IsNotExist(err) {
			failures = errors.Join(failures, err)
		}
	}
	return count, failures
}
