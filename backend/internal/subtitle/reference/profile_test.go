package reference

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestSearchUsesRetrievedArticlesWithoutGoogleGrounding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-goog-api-key") != "test-key" {
			t.Error("키 누락")
		}
		var request map[string]any
		json.NewDecoder(r.Body).Decode(&request)
		if _, ok := request["tools"]; ok {
			t.Error("Google 검색 도구를 용어 DB 수집에 사용함")
		}
		data, _ := json.Marshal(request)
		if !strings.Contains(string(data), "공개 작품 자료") || !strings.Contains(string(data), "작품명") {
			t.Error("참고 자료 누락")
		}
		c := map[string]any{"finishReason": "STOP", "content": map[string]any{"parts": []any{map[string]string{"text": `{"title":"作品","terms":[{"original":"名前","reading":"なまえ","korean":"이름"}]}`}}}}
		json.NewEncoder(w).Encode(map[string]any{"candidates": []any{c}})
	}))
	defer server.Close()
	p, err := search(context.Background(), server.Client(), server.URL, "test-key", "작품명", []article{{Title: "작품명", URL: "https://ja.wikipedia.org/wiki/Example", Text: "공개 작품 자료"}})
	if err != nil || len(p.Sources) != 1 || len(p.Terms) != 1 {
		t.Fatal(p, err)
	}
	if _, err = search(context.Background(), server.Client(), server.URL, "test-key", "작품명", nil); err == nil {
		t.Fatal("출처 없는 결과를 신뢰함")
	}
}

func TestWikipediaLookupIsBoundedAndKeepsSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("gsrsearch") != "작품명" || r.Header.Get("User-Agent") == "" {
			t.Error("조회 조건 누락")
		}
		json.NewEncoder(w).Encode(map[string]any{"query": map[string]any{"pages": map[string]any{"1": map[string]string{"title": "作品", "fullurl": "https://ja.wikipedia.org/wiki/Example", "extract": strings.Repeat("字", 15000)}}}})
	}))
	defer server.Close()
	articles, err := lookupArticle(context.Background(), server.Client(), server.URL, "작품명")
	if err != nil || len(articles) != 1 || len([]rune(articles[0].Text)) != 12000 || articles[0].Title != "作品" {
		t.Fatal(articles, err)
	}
}
