package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestVersionedWritePreservesPreviousOutputs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "whisper_ja.vtt")
	ctx := context.Background()
	if err := WriteVersionedFile(ctx, path, strings.NewReader("original")); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for _, text := range []string{"second", "third"} {
		wg.Add(1)
		go func(text string) {
			defer wg.Done()
			if err := WriteVersionedFile(ctx, path, strings.NewReader(text)); err != nil {
				t.Error(err)
			}
		}(text)
	}
	wg.Wait()
	contents := make(map[string]bool)
	data, _ := os.ReadFile(path)
	contents[string(data)] = true
	entries, err := os.ReadDir(filepath.Join(dir, ".history"))
	if err != nil || len(entries) != 2 {
		t.Fatalf("history: %v %v", entries, err)
	}
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(dir, ".history", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		contents[string(data)] = true
	}
	for _, value := range []string{"original", "second", "third"} {
		if !contents[value] {
			t.Fatalf("lost version: %s", value)
		}
	}
	before, _ := os.ReadFile(path)
	if err := WriteVersionedFile(ctx, path, brokenReader{}); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := WriteVersionedFile(cancelled, path, strings.NewReader("cancelled")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("failed write damaged current output")
	}
	entries, _ = os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatalf("temporary file leak: %v", entries)
	}
}

func TestVersionedWriteRejectsSymlinkAndUnsafeLanguage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "subtitle.vtt")
	original := filepath.Join(dir, "original")
	os.WriteFile(original, []byte("keep"), 0600)
	if err := os.Symlink(original, path); err != nil {
		t.Fatal(err)
	}
	if err := WriteVersionedFile(context.Background(), path, strings.NewReader("replace")); err == nil {
		t.Fatal("accepted symlink")
	}
	data, _ := os.ReadFile(original)
	if string(data) != "keep" {
		t.Fatal("symlink target changed")
	}
	for _, language := range []string{"", "../ko", "ko/../../escape", ".", "a\\b"} {
		if ValidFilenamePart(language) {
			t.Fatalf("accepted unsafe filename component: %q", language)
		}
	}
	if !ValidFilenamePart("pt-BR") {
		t.Fatal("rejected language tag")
	}
}
