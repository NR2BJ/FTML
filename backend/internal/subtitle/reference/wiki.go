package reference

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type article struct {
	Title string `json:"title"`
	URL   string `json:"url"`
	Text  string `json:"text"`
}

// 외부 문서의 링크를 따라가지 않고 고정한 공개 백과사전 API만 조회한다.
func lookupWikipedia(ctx context.Context, client *http.Client, title string) ([]article, error) {
	var articles []article
	for _, language := range []string{"ja", "ko", "en"} {
		found, err := lookupArticle(ctx, client, "https://"+language+".wikipedia.org/w/api.php", title)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if err == nil {
			articles = append(articles, found...)
		}
	}
	if len(articles) == 0 {
		return nil, fmt.Errorf("작품 자료를 찾지 못했습니다. 원어 작품명·시즌을 확인하거나 용어를 직접 입력해 주세요")
	}
	return articles, nil
}

func lookupArticle(ctx context.Context, client *http.Client, endpoint, title string) ([]article, error) {
	query := url.Values{"action": {"query"}, "format": {"json"}, "generator": {"search"}, "gsrsearch": {title},
		"gsrnamespace": {"0"}, "gsrlimit": {"1"}, "prop": {"extracts|info"}, "inprop": {"url"}, "explaintext": {"1"}, "exlimit": {"1"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "FTML/1.0 (https://github.com/NR2BJ/FTML)")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("작품 자료 조회 실패 (HTTP %d)", res.StatusCode)
	}
	var response struct {
		Query struct {
			Pages map[string]struct {
				Title string `json:"title"`
				URL   string `json:"fullurl"`
				Text  string `json:"extract"`
			} `json:"pages"`
		} `json:"query"`
	}
	if err = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&response); err != nil {
		return nil, err
	}
	var result []article
	for _, page := range response.Query.Pages {
		if !ValidURL(page.URL) || strings.TrimSpace(page.Text) == "" {
			continue
		}
		text := []rune(page.Text)
		if len(text) > 12000 {
			text = text[:12000]
		}
		result = append(result, article{Title: page.Title, URL: page.URL, Text: string(text)})
	}
	return result, nil
}
