package storage

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

type TrashedSubtitle struct {
	ID         string    `json:"id"`
	Filename   string    `json:"filename"`
	Label      string    `json:"label"`
	DeletedAt  time.Time `json:"deleted_at"`
	VideoPath  string    `json:"video_path,omitempty"`
	StorageKey string    `json:"storage_key,omitempty"`
}

func trashFilename(name string) bool {
	return name == filepath.Base(name) && !strings.HasPrefix(name, ".") && !strings.Contains(name, "..") && IsSubtitleFile(name)
}

func plainDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: 일반 폴더가 아닙니다", os.ErrPermission)
	}
	return nil
}

func trashDirectory(directory string, create bool) (string, error) {
	if err := plainDirectory(directory); err != nil {
		return "", err
	}
	path := filepath.Join(directory, ".trash")
	if create {
		if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
			return "", err
		}
	}
	return path, plainDirectory(path)
}

// 생성/업로드와 같은 잠금을 사용한다. 메타데이터를 먼저 기록한 뒤 원본을
// 원자적으로 옮겨, 중단되어도 휴지통 파일의 복구 이름이 남도록 한다.
func TrashSubtitle(directory, filename, label string, videoPath ...string) (TrashedSubtitle, error) {
	versionedWriteMu.Lock()
	defer versionedWriteMu.Unlock()
	if label == "" || len(label) > 8192 {
		label = filename
	}
	entry := TrashedSubtitle{ID: uuid.NewString(), Filename: filename, Label: label, DeletedAt: time.Now().UTC()}
	if len(videoPath) > 0 && len(videoPath[0]) <= 8192 {
		entry.VideoPath = videoPath[0]
	}
	if !trashFilename(filename) {
		return entry, os.ErrPermission
	}
	root, err := trashDirectory(directory, true)
	if err != nil {
		return entry, err
	}
	source := filepath.Join(directory, filename)
	info, err := os.Lstat(source)
	if err != nil {
		return entry, err
	}
	if !info.Mode().IsRegular() {
		return entry, os.ErrPermission
	}
	item := filepath.Join(root, entry.ID)
	if err := os.Mkdir(item, 0700); err != nil {
		return entry, err
	}
	data, err := json.Marshal(entry)
	if err == nil && len(data) > 64*1024 {
		entry.Label = filename
		data, err = json.Marshal(entry)
	}
	if err == nil {
		_, err = WriteNewFile(filepath.Join(item, "metadata.json"), bytes.NewReader(data))
	}
	if err == nil {
		err = MoveNoReplace(source, filepath.Join(item, "subtitle"))
	}
	if err != nil {
		_ = os.RemoveAll(item)
	}
	return entry, err
}

func readTrashedSubtitle(root, id string) (TrashedSubtitle, error) {
	var entry TrashedSubtitle
	parsed, err := uuid.Parse(id)
	if err != nil || parsed.String() != id {
		return entry, os.ErrPermission
	}
	item := filepath.Join(root, id)
	if err := plainDirectory(item); err != nil {
		return entry, err
	}
	for _, name := range []string{"metadata.json", "subtitle"} {
		info, err := os.Lstat(filepath.Join(item, name))
		if err != nil {
			return entry, err
		}
		if !info.Mode().IsRegular() || (name == "metadata.json" && info.Size() > 64*1024) {
			return entry, os.ErrPermission
		}
	}
	data, err := os.ReadFile(filepath.Join(item, "metadata.json"))
	if err != nil {
		return entry, err
	}
	if err := json.Unmarshal(data, &entry); err != nil {
		return entry, err
	}
	if entry.ID != id || !trashFilename(entry.Filename) {
		return entry, os.ErrPermission
	}
	return entry, nil
}

func ListSubtitleTrash(directory string) ([]TrashedSubtitle, error) {
	versionedWriteMu.Lock()
	defer versionedWriteMu.Unlock()
	result := []TrashedSubtitle{}
	root, err := trashDirectory(directory, false)
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	items, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		entry, err := readTrashedSubtitle(root, item.Name())
		if err == nil {
			result = append(result, entry)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].DeletedAt.After(result[j].DeletedAt) })
	return result, nil
}

func RestoreSubtitle(directory, id string) (TrashedSubtitle, error) {
	versionedWriteMu.Lock()
	defer versionedWriteMu.Unlock()
	root, err := trashDirectory(directory, false)
	if err != nil {
		return TrashedSubtitle{}, err
	}
	entry, err := readTrashedSubtitle(root, id)
	if err != nil {
		return entry, err
	}
	item := filepath.Join(root, id)
	if err := MoveNoReplace(filepath.Join(item, "subtitle"), filepath.Join(directory, entry.Filename)); err != nil {
		return entry, err
	}
	_ = os.Remove(filepath.Join(item, "metadata.json"))
	_ = os.Remove(item)
	return entry, nil
}
