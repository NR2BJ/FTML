package api

import (
	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/video-stream/backend/internal/api/handlers"
	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/ffmpeg"
)

func NewRouter(database *db.Database, jwtService *auth.JWTService, mediaPath, dataPath string) *chi.Mux {
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimw.Recoverer)
	r.Use(chimw.RealIP)
	r.Use(middleware.Logger)
	r.Use(cors.Handler(middleware.CORSHandler()))

	// Handlers
	authHandler := handlers.NewAuthHandler(database, jwtService)
	filesHandler := handlers.NewFilesHandler(mediaPath, dataPath)
	hlsManager := ffmpeg.NewHLSManager(dataPath)
	streamHandler := handlers.NewStreamHandler(mediaPath, hlsManager)
	userHandler := handlers.NewUserHandler(database)
	subtitleHandler := handlers.NewSubtitleHandler(mediaPath)

	// Public routes
	r.Route("/api", func(r chi.Router) {
		// Auth (public)
		r.Post("/auth/login", authHandler.Login)

		// Protected routes
		r.Group(func(r chi.Router) {
			r.Use(middleware.AuthMiddleware(jwtService))

			// Auth
			r.Get("/auth/me", authHandler.Me)

			// Files
			r.Get("/files/tree", filesHandler.GetTree)
			r.Get("/files/tree/*", filesHandler.GetTree)
			r.Get("/files/info/*", filesHandler.GetInfo)
			r.Get("/files/thumbnail/*", filesHandler.GetThumbnail)
			r.Get("/files/search", filesHandler.Search)

			// Streaming
			r.Get("/stream/presets/*", streamHandler.PresetsHandler)
			r.Get("/stream/hls/*", streamHandler.HLSHandler)
			r.Get("/stream/direct/*", streamHandler.DirectPlay)

			// Subtitles
			r.Get("/subtitle/list/*", subtitleHandler.ListSubtitles)
			r.Get("/subtitle/content/*", subtitleHandler.ServeSubtitle)

			// User
			r.Put("/user/history/*", userHandler.SavePosition)
			r.Get("/user/history/*", userHandler.GetPosition)
		})
	})

	return r
}
