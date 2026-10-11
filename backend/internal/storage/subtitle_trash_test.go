package storage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestSubtitleTrashPreservesBytesAndRefusesOverwrite(t *testing.T) {
	dir := t.TempDir()
	name := "translate_ko_gemini.ass"
	original := "[Events]\nDialogue: {\\pos(10,20)}원본 효과\n"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	entry, err := TrashSubtitle(dir, name, "번역 ← 원본")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
		t.Fatal("삭제 후 원래 위치에 남음", err)
	}
	entries, err := ListSubtitleTrash(dir)
	if err != nil || len(entries) != 1 || entries[0].Label != entry.Label {
		t.Fatal(entries, err)
	}
	if err := WriteVersionedFile(context.Background(), filepath.Join(dir, name), strings.NewReader("새 자막")); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreSubtitle(dir, entry.ID); !os.IsExist(err) {
		t.Fatal("기존 파일 충돌을 거절해야 함", err)
	}
	newer, err := TrashSubtitle(dir, name, "새 자막")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreSubtitle(dir, entry.ID); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil || string(data) != original {
		t.Fatal("원본 바이트 소실", err)
	}
	entries, err = ListSubtitleTrash(dir)
	if err != nil || len(entries) != 1 || entries[0].ID != newer.ID {
		t.Fatal(entries, err)
	}
}

func TestSubtitleTrashConcurrentRestoreMovesOnlyOnce(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.vtt"), []byte("원문"), 0600); err != nil {
		t.Fatal(err)
	}
	entry, err := TrashSubtitle(dir, "a.vtt", "원문")
	if err != nil {
		t.Fatal(err)
	}
	var successes atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := RestoreSubtitle(dir, entry.ID); err == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatal(successes.Load())
	}
}

func TestSubtitleTrashRejectsSymlinksAndTraversal(t *testing.T) {
	for _, target := range []string{"directory", "trash", "source"} {
		t.Run(target, func(t *testing.T) {
			root, outside := t.TempDir(), t.TempDir()
			dir := filepath.Join(root, "video")
			if target == "directory" {
				os.Symlink(outside, dir)
			} else {
				os.Mkdir(dir, 0700)
			}
			if target == "trash" {
				os.Symlink(outside, filepath.Join(dir, ".trash"))
			}
			if target == "source" {
				os.Symlink(filepath.Join(outside, "a.vtt"), filepath.Join(dir, "a.vtt"))
			} else {
				os.WriteFile(filepath.Join(dir, "a.vtt"), []byte("元"), 0600)
			}
			if _, err := TrashSubtitle(dir, "a.vtt", "label"); err == nil {
				t.Fatal("심볼릭 링크를 허용함")
			}
		})
	}
	dir := t.TempDir()
	for _, name := range []string{"../a.vtt", "a/b.vtt", "metadata.json", ".history"} {
		if _, err := TrashSubtitle(dir, name, name); err == nil {
			t.Fatal(name)
		}
	}
	if _, err := RestoreSubtitle(dir, "../"); err == nil {
		t.Fatal("복구 경로 탈출 허용")
	}
	if entries, err := ListSubtitleTrash(filepath.Join(dir, "missing")); err != nil || len(entries) != 0 {
		t.Fatal(entries, err)
	}
}

func TestSubtitleTrashIncompleteMoveIsNotListed(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.vtt"), []byte("a"), 0600)
	entry, err := TrashSubtitle(dir, "a.vtt", "a")
	if err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(dir, ".trash", entry.ID, "subtitle"))
	entries, err := ListSubtitleTrash(dir)
	if err != nil || len(entries) != 0 {
		t.Fatal(entries, err)
	}
	if _, err := RestoreSubtitle(dir, entry.ID); !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestSubtitleTrashLongUntrustedLabelRemainsRecoverable(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.vtt"), []byte("original"), 0600)
	entry, err := TrashSubtitle(dir, "a.vtt", strings.Repeat("x", 100000))
	if err != nil {
		t.Fatal(err)
	}
	entries, err := ListSubtitleTrash(dir)
	if err != nil || len(entries) != 1 || entries[0].Label != "a.vtt" {
		t.Fatal(entries, err)
	}
	if _, err := RestoreSubtitle(dir, entry.ID); err != nil {
		t.Fatal(err)
	}
}

func TestSubtitleTrashEscapedMetadataRemainsReadable(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.vtt"), []byte("original"), 0600)
	entry, err := TrashSubtitle(dir, "a.vtt", strings.Repeat("<", 8192), strings.Repeat("<", 8192))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreSubtitle(dir, entry.ID); err != nil {
		t.Fatal(err)
	}
}
