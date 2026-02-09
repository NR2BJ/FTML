package middleware

import (
	"net/http"
	"sync"
	"time"
)

// rateBucket tracks request counts per IP within a time window.
type rateBucket struct {
	count    int
	resetAt  time.Time
}

// RateLimiter provides IP-based rate limiting middleware.
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*rateBucket
	limit   int
	window  time.Duration
}

// NewRateLimiter creates a rate limiter: max `limit` requests per `window` per IP.
func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		buckets: make(map[string]*rateBucket),
		limit:   limit,
		window:  window,
	}
	// Cleanup stale entries every minute
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			rl.cleanup()
		}
	}()
	return rl
}

func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	for ip, b := range rl.buckets {
		if now.After(b.resetAt) {
			delete(rl.buckets, ip)
		}
	}
}

// RateLimitEntry represents a single IP's rate limit status.
type RateLimitEntry struct {
	IP      string    `json:"ip"`
	Count   int       `json:"count"`
	ResetAt time.Time `json:"reset_at"`
}

// RateLimitStatus is returned by the admin API.
type RateLimitStatus struct {
	Limit   int              `json:"limit"`
	Window  string           `json:"window"`
	Entries []RateLimitEntry `json:"entries"`
}

// Status returns the current state of all tracked IPs.
func (rl *RateLimiter) Status() RateLimitStatus {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	entries := make([]RateLimitEntry, 0, len(rl.buckets))
	now := time.Now()
	for ip, b := range rl.buckets {
		if now.Before(b.resetAt) {
			entries = append(entries, RateLimitEntry{
				IP:      ip,
				Count:   b.count,
				ResetAt: b.resetAt,
			})
		}
	}
	return RateLimitStatus{
		Limit:   rl.limit,
		Window:  rl.window.String(),
		Entries: entries,
	}
}

// Clear removes all tracked rate limit entries.
func (rl *RateLimiter) Clear() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.buckets = make(map[string]*rateBucket)
}

// Handler returns an http.Handler middleware that enforces the rate limit.
func (rl *RateLimiter) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := r.RemoteAddr // chi RealIP middleware sets this to the actual client IP

		rl.mu.Lock()
		now := time.Now()
		b, exists := rl.buckets[ip]
		if !exists || now.After(b.resetAt) {
			b = &rateBucket{count: 0, resetAt: now.Add(rl.window)}
			rl.buckets[ip] = b
		}
		b.count++
		allowed := b.count <= rl.limit
		rl.mu.Unlock()

		if !allowed {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"too many requests, try again later"}`))
			return
		}

		next.ServeHTTP(w, r)
	})
}
