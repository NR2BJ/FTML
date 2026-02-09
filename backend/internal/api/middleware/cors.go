package middleware

import (
	"github.com/go-chi/cors"
)

func CORSHandler(allowedOrigins []string) cors.Options {
	if len(allowedOrigins) == 0 {
		allowedOrigins = []string{"*"}
	}

	// When wildcard is used, disable AllowCredentials to prevent CSRF
	allowCreds := true
	for _, o := range allowedOrigins {
		if o == "*" {
			allowCreds = false
			break
		}
	}

	return cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Content-Length", "Content-Range"},
		AllowCredentials: allowCreds,
		MaxAge:           300,
	}
}
