package middleware

import "net/http"

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
