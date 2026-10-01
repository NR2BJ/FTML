package storage

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/google/uuid"
)

var versionedWriteMu sync.Mutex
var filenamePart = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func ValidFilenamePart(value string) bool {
	return filenamePart.MatchString(value)
}

// WriteVersionedFile keeps the old file readable until its replacement is
// fully written, and preserves each replaced version in a private directory.
func WriteVersionedFile(ctx context.Context, destination string, source io.Reader) error {
	versionedWriteMu.Lock()
	defer versionedWriteMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(destination), ".ftml-subtitle-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if _, err := io.Copy(f, source); err != nil {
		return err
	}
	if err := f.Chmod(0644); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if info, err := os.Lstat(destination); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("기존 자막이 일반 파일이 아닙니다")
		}
		historyDir := filepath.Join(filepath.Dir(destination), ".history")
		if err := os.MkdirAll(historyDir, 0700); err != nil {
			return err
		}
		info, err := os.Lstat(historyDir)
		if err != nil || !info.IsDir() {
			return fmt.Errorf("자막 이력 폴더가 올바르지 않습니다")
		}
		original, err := os.Open(destination)
		if err != nil {
			return err
		}
		defer original.Close()
		backup := filepath.Join(historyDir, uuid.NewString()+"_"+filepath.Base(destination))
		if _, err := WriteNewFile(backup, original); err != nil {
			return fmt.Errorf("기존 자막 보존 실패: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(f.Name(), destination)
}
