package db

import (
	"path/filepath"
	"testing"
)

func TestLegacyJobLinksMigrationKeepsHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	d, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.db.Exec(`INSERT INTO jobs(id,type,status,file_path,params,result) VALUES('old','transcribe','completed','old.mkv','{}','{"output_path":"generated:old.vtt"}');
		DROP INDEX idx_jobs_parent; DROP INDEX idx_jobs_retry;
		ALTER TABLE jobs DROP COLUMN parent_id; ALTER TABLE jobs DROP COLUMN retry_of;`)
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	for i := 0; i < 2; i++ {
		d, err = NewSQLite(path)
		if err != nil {
			t.Fatal(err)
		}
		var status, result, parent, retry string
		if err = d.db.QueryRow("SELECT status,result,parent_id,retry_of FROM jobs WHERE id='old'").Scan(&status, &result, &parent, &retry); err != nil {
			t.Fatal(err)
		}
		if status != "completed" || result != `{"output_path":"generated:old.vtt"}` || parent != "" || retry != "" {
			t.Fatal(status, result, parent, retry)
		}
		d.Close()
	}
}
