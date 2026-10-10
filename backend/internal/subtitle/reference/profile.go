package reference

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/video-stream/backend/internal/db"
)

type Term struct {
	Original string `json:"original"`
	Reading  string `json:"reading"`
	Korean   string `json:"korean"`
}
type Source struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}
type Song struct {
	Title   string `json:"title"`
	Artist  string `json:"artist"`
	Version string `json:"version"`
}
type Profile struct {
	Scope   string   `json:"scope"`
	Title   string   `json:"title"`
	Terms   []Term   `json:"terms"`
	Songs   []Song   `json:"songs"`
	Sources []Source `json:"sources"`
}

func key(scope string) string {
	return fmt.Sprintf("subtitle_reference_%x", sha256.Sum256([]byte(scope)))
}

func ValidURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil
}

func (p *Profile) Validate() error {
	if p.Scope != path.Clean(p.Scope) || path.IsAbs(p.Scope) || p.Scope == ".." || strings.HasPrefix(p.Scope, "../") || strings.Contains(p.Scope, "\\") {
		return fmt.Errorf("잘못된 작품 폴더입니다")
	}
	if utf8.RuneCountInString(p.Title) > 200 || len(p.Terms) > 80 || len(p.Songs) > 20 || len(p.Sources) > 30 {
		return fmt.Errorf("작품 참고 자료가 너무 큽니다")
	}
	for _, t := range p.Terms {
		if strings.TrimSpace(t.Original) == "" || utf8.RuneCountInString(t.Original+t.Reading+t.Korean) > 200 {
			return fmt.Errorf("잘못된 용어 항목입니다")
		}
	}
	for _, s := range p.Sources {
		if !ValidURL(s.URL) || len(s.URL) > 2000 || len(s.Title) > 500 {
			return fmt.Errorf("잘못된 참고 출처입니다")
		}
	}
	for _, s := range p.Songs {
		if len(s.Title+s.Artist+s.Version) > 1000 {
			return fmt.Errorf("곡 정보가 너무 깁니다")
		}
	}
	return nil
}

func Load(database *db.Database, video string) Profile {
	scope := path.Dir(video)
	if scope == "." {
		scope = video
	}
	for current := video; ; current = path.Dir(current) {
		var profile Profile
		if json.Unmarshal([]byte(database.GetSetting(key(current), "")), &profile) == nil && profile.Scope == current && profile.Validate() == nil {
			return profile
		}
		if path.Dir(current) == "." || current == "/" {
			break
		}
	}
	return Profile{Scope: scope, Terms: []Term{}, Songs: []Song{}, Sources: []Source{}}
}

func Save(database *db.Database, p Profile) error {
	if err := p.Validate(); err != nil {
		return err
	}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return database.SetSetting(key(p.Scope), string(data))
}

func (p Profile) Hints() string {
	var hints []string
	for _, term := range p.Terms {
		value := term.Original
		if term.Reading != "" {
			value += " (" + term.Reading + ")"
		}
		if utf8.RuneCountInString(strings.Join(append(hints, value), ", ")) > 1000 {
			break
		}
		hints = append(hints, value)
	}
	return strings.Join(hints, ", ")
}

func (p Profile) TranslationContext() string {
	// 출처와 곡 후보는 대사나 가사의 대체 원문으로 보내지 않는다.
	data, _ := json.Marshal(struct {
		Title string `json:"title"`
		Terms []Term `json:"terms"`
	}{p.Title, p.Terms})
	if len(p.Terms) == 0 {
		return ""
	}
	return string(data)
}
