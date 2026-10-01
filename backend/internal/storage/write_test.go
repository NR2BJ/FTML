package storage

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type brokenReader struct{}

func (brokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestWriteNewFileNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "video.mkv")
	if _, err := WriteNewFile(path, strings.NewReader("original")); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteNewFile(path, strings.NewReader("replacement")); !os.IsExist(err) {
		t.Fatalf("expected conflict, got %v", err)
	}
	if _, err := WriteNewFile(path, brokenReader{}); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "original" {
		t.Fatalf("original changed: %q %v", data, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary upload leaked: %v", entries)
	}
}

func TestMoveNoReplacePreservesBothFiles(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	os.WriteFile(a, []byte("a"), 0600)
	os.WriteFile(b, []byte("b"), 0600)
	if err := MoveNoReplace(a, b); !os.IsExist(err) {
		t.Fatalf("expected conflict: %v", err)
	}
	for _, path := range []string{a, b} {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != filepath.Base(path) {
			t.Fatalf("file damaged: %s", path)
		}
	}
}
