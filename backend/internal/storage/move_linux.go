//go:build linux

package storage

import "golang.org/x/sys/unix"

// MoveNoReplace preserves an existing destination even when another writer
// creates it between validation and publication.
func MoveNoReplace(source, destination string) error {
	return unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, destination, unix.RENAME_NOREPLACE)
}
