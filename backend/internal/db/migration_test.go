package db

import (
	"path/filepath"
	"testing"
)

func TestAuthVersionMigrationPreservesExistingUsers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	d, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.CreateUser("existing", "hash", "user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.db.Exec("ALTER TABLE users DROP COLUMN auth_version"); err != nil {
		t.Fatal(err)
	}
	d.Close()
	for i := 0; i < 2; i++ {
		d, err = NewSQLite(path)
		if err != nil {
			t.Fatal(err)
		}
		u, err := d.GetUserByUsername("existing")
		if err != nil || u.AuthVersion != 0 || u.Password != "hash" {
			t.Fatalf("migration changed user: %+v %v", u, err)
		}
		d.Close()
	}
}
