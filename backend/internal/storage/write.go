package storage

import (
	"io"
	"os"
	"path/filepath"
)

// WriteNewFile publishes only a completely written file, never replacing a
// destination. The temporary file shares the destination filesystem.
func WriteNewFile(destination string, source io.Reader) (int64, error) {
	f, err := os.CreateTemp(filepath.Dir(destination), ".ftml-upload-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	n, err := io.Copy(f, source)
	if err != nil {
		return n, err
	}
	if err = f.Chmod(0644); err != nil {
		return n, err
	}
	if err = f.Sync(); err != nil {
		return n, err
	}
	if err = f.Close(); err != nil {
		return n, err
	}
	if err = MoveNoReplace(f.Name(), destination); err != nil {
		return n, err
	}
	return n, nil
}
