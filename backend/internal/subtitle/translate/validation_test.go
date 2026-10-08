package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var testCues = []SubtitleCue{
	{Index: 3, Start: 1, End: 2, Text: "one"},
	{Index: 7, Start: 3, End: 4, Text: "two"},
}

type fakeTransport func(*http.Request) (*http.Response, error)

func (f fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func responseJSON(body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func geminiResponse(content, reason string) string {
	runes := []rune(content)
	body, _ := json.Marshal(map[string]any{"candidates": []any{map[string]any{
		"finishReason": reason,
		"content": map[string]any{"parts": []any{
			map[string]any{"thought": true, "text": "not the translation"},
			map[string]any{"text": string(runes[:len(runes)/2])},
			map[string]any{"text": string(runes[len(runes)/2:])},
		}},
	}}})
	return string(body)
}

func TestIdentifiedTranslations(t *testing.T) {
	got, err := parseIdentifiedTranslations(testCues, `[{"id":7,"text":"둘"},{"id":3,"text":"하나"}]`)
	if err != nil || len(got) != 2 || got[0].Text != "하나" || got[1].Text != "둘" {
		t.Fatalf("mapping: %+v %v", got, err)
	}
	if err := validateTranslatedCues(testCues, got); err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{
		`[{"id":3,"text":"one"}]`,
		`[{"id":3,"text":"one"},{"id":3,"text":"two"}]`,
		`[{"id":3,"text":"one"},{"id":8,"text":"two"}]`,
		`[{"id":3,"text":"one"},{"id":7,"text":" "}]`,
		`[{"id":3,"text":"one"},{"text":"two"}]`,
		`["one","two"]`,
	} {
		if _, err := parseIdentifiedTranslations(testCues, content); err == nil {
			t.Fatalf("accepted invalid response: %s", content)
		}
	}
}

func TestGeminiResponseIntegrity(t *testing.T) {
	g := NewGeminiTranslator("test-key", func() string { return "selected-model" })
	for _, reason := range []string{"STOP", "MAX_TOKENS", "SAFETY"} {
		g.httpClient.Transport = fakeTransport(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("x-goog-api-key") != "test-key" || r.URL.RawQuery != "" {
				t.Fatal("key must only be in the header")
			}
			var request map[string]any
			json.NewDecoder(r.Body).Decode(&request)
			if request["generationConfig"].(map[string]any)["responseSchema"] == nil {
				t.Fatal("missing response schema")
			}
			return responseJSON(geminiResponse(`[{"id":7,"text":"two"},{"id":3,"text":"one"}]`, reason)), nil
		})
		got, err := g.Translate(context.Background(), testCues, TranslateOptions{}, func(float64) {})
		if reason == "STOP" && (err != nil || !reflect.DeepEqual(got, testCues)) {
			t.Fatalf("response: %+v %v", got, err)
		}
		if reason != "STOP" && err == nil {
			t.Fatalf("unfinished/blocked response was accepted: %s", reason)
		}
	}
}

func TestGeminiSubdividesIncompleteResponse(t *testing.T) {
	g := NewGeminiTranslator("test", func() string { return "selected-model" })
	cues := make([]SubtitleCue, 20)
	for i := range cues {
		cues[i] = SubtitleCue{Index: i + 1, Start: float64(i), End: float64(i + 1), Text: "input"}
	}
	calls := 0
	g.httpClient.Transport = fakeTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return responseJSON(geminiResponse(`[]`, "STOP")), nil
		}
		var request struct {
			Contents []struct{ Parts []struct{ Text string } }
		}
		json.NewDecoder(r.Body).Decode(&request)
		matches := regexp.MustCompile(`(?m)^\[(\d+)\]`).FindAllStringSubmatch(request.Contents[0].Parts[0].Text, -1)
		var entries []map[string]any
		for _, match := range matches {
			id, _ := strconv.Atoi(match[1])
			entries = append(entries, map[string]any{"id": id, "text": fmt.Sprint(id)})
		}
		data, _ := json.Marshal(entries)
		return responseJSON(geminiResponse(string(data), "STOP")), nil
	})
	got, err := g.Translate(context.Background(), cues, TranslateOptions{}, func(float64) {})
	if err != nil || calls != 3 || len(got) != 20 {
		t.Fatalf("subdivision: %d calls, %d cues, %v", calls, len(got), err)
	}
	if err := validateTranslatedCues(cues, got); err != nil {
		t.Fatal(err)
	}
}

func TestGeminiRequiresExplicitModel(t *testing.T) {
	g := NewGeminiTranslator("test", nil)
	g.httpClient.Transport = fakeTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("must not choose a billable model implicitly")
		return nil, nil
	})
	if _, err := g.Translate(context.Background(), testCues, TranslateOptions{}, func(float64) {}); err == nil {
		t.Fatal("missing model accepted")
	}
}
