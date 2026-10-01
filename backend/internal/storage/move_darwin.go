//go:build darwin

package storage

import "golang.org/x/sys/unix"

func MoveNoReplace(source, destination string) error {
	return unix.RenamexNp(source, destination, unix.RENAME_EXCL)
}
