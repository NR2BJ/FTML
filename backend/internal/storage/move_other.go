//go:build !linux && !darwin

package storage

import "errors"

func MoveNoReplace(source, destination string) error {
	return errors.New("atomic non-overwriting moves require Linux or macOS")
}
