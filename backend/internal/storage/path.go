package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ResolveWithinBase returns an absolute path for requestedPath and rejects any
// path that escapes basePath.
func ResolveWithinBase(basePath, requestedPath string) (string, error) {
	absBase, err := filepath.Abs(basePath)
	if err != nil {
		return "", err
	}

	absTarget, err := filepath.Abs(filepath.Join(absBase, requestedPath))
	if err != nil {
		return "", err
	}

	rel, err := filepath.Rel(absBase, absTarget)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("%w: %s", os.ErrPermission, requestedPath)
	}

	return absTarget, nil
}
