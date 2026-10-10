package db

import (
	"path/filepath"
	"testing"
)

func TestLocalASRMigrationPreservesConnectionsAndHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	d, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	local, err := d.ListWhisperBackends()
	if err != nil || len(local) != 1 {
		t.Fatal(local, err)
	}
	id := local[0].ID
	if err = d.UpdateWhisperBackend(id, "A380", "openvino-genai", "http://custom:8178", false, 3); err != nil {
		t.Fatal(err)
	}
	cloud, err := d.CreateWhisperBackend("Cloud", "openai", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = d.db.Exec(`INSERT INTO settings(key,value) VALUES ('openai_api_key','fixture-secret'),('whisper_model_id','old'),('gemini_api_key','keep');
		INSERT INTO jobs(id,type,file_path,params) VALUES ('history','transcribe','video.mkv','{}')`); err != nil {
		t.Fatal(err)
	}
	d.Close()
	for i := 0; i < 2; i++ {
		d, err = NewSQLite(path)
		if err != nil {
			t.Fatal(err)
		}
		if d.GetSetting("openai_api_key", "") != "" || d.GetSetting("whisper_model_id", "") != "" || d.GetSetting("gemini_api_key", "") != "keep" {
			t.Fatal("설정 이전 실패")
		}
		b, err := d.GetWhisperBackend(id)
		if err != nil || b.Enabled || b.URL != "http://custom:8178" || b.Priority != 3 {
			t.Fatal(b, err)
		}
		b, err = d.GetWhisperBackend(cloud)
		if err != nil || b.Enabled {
			t.Fatal(b, err)
		}
		list, _ := d.ListWhisperBackends()
		if len(list) != 2 {
			t.Fatal("연결 중복", list)
		}
		var count int
		if err = d.db.QueryRow("SELECT count(*) FROM jobs WHERE id='history'").Scan(&count); err != nil || count != 1 {
			t.Fatal("이력 손실", err)
		}
		d.Close()
	}
}
