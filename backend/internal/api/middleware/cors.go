package middleware

import (
	"github.com/go-chi/cors"
)

func CORSHandler() cors.Options {
	return cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Content-Length", "Content-Range"},
		AllowCredentials: true,
		MaxAge:           300,
	}
}
