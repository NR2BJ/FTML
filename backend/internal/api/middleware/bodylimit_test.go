package middleware

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBodyLimitsDistinguishUploadsFromJSON(t *testing.T) {
	for _, tc := range []struct {
		path string
		size int
		want int
	}{
		{"/api/settings", 2 << 20, 413},
		{"/api/files/upload/movies", 2 << 20, 413},
		{"/api/subtitle/upload/video.mkv", 2 << 20, 204},
		{"/api/subtitle/upload/video.mkv", 11 << 20, 413},
	} {
		t.Run(fmt.Sprintf("%s/%d", tc.path, tc.size), func(t *testing.T) {
			h := RequestBodyLimit(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if _, err := io.Copy(io.Discard, r.Body); err != nil {
					w.WriteHeader(413)
					return
				}
				w.WriteHeader(204)
			}))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("POST", tc.path, strings.NewReader(strings.Repeat("x", tc.size))))
			if w.Code != tc.want {
				t.Fatalf("got %d, want %d", w.Code, tc.want)
			}
		})
	}
}
