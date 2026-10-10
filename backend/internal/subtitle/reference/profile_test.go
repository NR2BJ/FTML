package reference

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/video-stream/backend/internal/db"
)

func TestProfileScopeAndHints(t *testing.T) {
	d, err := db.NewSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	p := Profile{Scope: "anime/series", Title: "作品", Terms: []Term{{Original: "名前", Reading: "なまえ", Korean: "이름"}}}
	if err = Save(d, p); err != nil {
		t.Fatal(err)
	}
	if got := Load(d, "anime/series/season/01.mkv"); got.Title != p.Title || !strings.Contains(got.Hints(), "なまえ") {
		t.Fatal(got)
	}
	if got := Load(d, "anime/series-other/01.mkv"); got.Title != "" {
		t.Fatal("다른 작품 사전 누출", got)
	}
	root := Load(d, "movie.mkv")
	root.Title = "영화"
	if err = Save(d, root); err != nil {
		t.Fatal(err)
	}
	if Load(d, "other.mkv").Title != "" || Load(d, "anime/another/01.mkv").Title != "" {
		t.Fatal("루트 영상 사전이 다른 작품에 적용됨")
	}
	for _, scope := range []string{"../escape", "/absolute", "a/../b"} {
		p.Scope = scope
		if p.Validate() == nil {
			t.Fatal(scope)
		}
	}
}
