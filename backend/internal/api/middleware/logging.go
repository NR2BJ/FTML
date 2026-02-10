package middleware

import (
	"log"
	"net/http"
	"time"
)

type wrappedWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *wrappedWriter) WriteHeader(code int) {
	w.statusCode = code
	w.ResponseWriter.WriteHeader(code)
}

// silentPaths are high-frequency polling endpoints that are only logged on errors (status >= 400).
var silentPaths = map[string]bool{
	"/api/health":                      true,
	"/api/admin/registrations/count":   true,
	"/api/admin/delete-requests/count": true,
	"/api/jobs/active":                 true,
}

func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		wrapped := &wrappedWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(wrapped, r)
		if silentPaths[r.URL.Path] && wrapped.statusCode < 400 {
			return
		}
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, wrapped.statusCode, time.Since(start))
	})
}
