package middleware

import (
	"net/http"
	"strings"
)

// Upload limits must be chosen before wrapping the body: an outer wrapper
// cannot increase a limit already imposed by an inner MaxBytesReader.
func RequestBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := int64(1 << 20)
		if r.Method == http.MethodPost {
			switch {
			case strings.HasPrefix(r.URL.Path, "/api/subtitle/upload/"):
				limit = 10 << 20
			}
		}
		MaxBodySize(limit)(next).ServeHTTP(w, r)
	})
}

// MaxBodySize limits the request body to the given number of bytes.
// Use on JSON API routes to prevent memory exhaustion from oversized payloads.
// File upload routes should use their own http.MaxBytesReader with larger limits.
func MaxBodySize(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}
