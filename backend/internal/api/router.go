package api

import (
	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/video-stream/backend/internal/api/handlers"
	"github.com/video-stream/backend/internal/api/middleware"
	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/config"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/job"
)

func NewRouter(database *db.Database, jwtService *auth.JWTService, cfg *config.Config, jobQueue *job.JobQueue) *chi.Mux {
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimw.Recoverer)
	r.Use(chimw.RealIP)
	r.Use(middleware.Logger)
	r.Use(cors.Handler(middleware.CORSHandler()))

	// Handlers
	authHandler := handlers.NewAuthHandler(database, jwtService)
	filesHandler := handlers.NewFilesHandler(cfg.MediaPath, cfg.DataPath)
	hlsManager := ffmpeg.NewHLSManager(cfg.DataPath)
	streamHandler := handlers.NewStreamHandler(cfg.MediaPath, hlsManager)
	userHandler := handlers.NewUserHandler(database)
	subtitleHandler := handlers.NewSubtitleHandler(cfg.MediaPath, cfg.SubtitlePath, jobQueue)
	jobHandler := handlers.NewJobHandler(jobQueue)
	settingsHandler := handlers.NewSettingsHandler(database)

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
			r.Post("/files/batch-info", filesHandler.BatchInfo)

			// Streaming
			r.Get("/stream/capabilities", streamHandler.CapabilitiesHandler)
			r.Get("/stream/presets/*", streamHandler.PresetsHandler)
			r.Get("/stream/hls/*", streamHandler.HLSHandler)
			r.Get("/stream/direct/*", streamHandler.DirectPlay)
			r.Post("/stream/heartbeat/{sessionID}", streamHandler.HeartbeatHandler)
			r.Post("/stream/pause/{sessionID}", streamHandler.PauseHandler)
			r.Post("/stream/resume/{sessionID}", streamHandler.ResumeHandler)
			r.Delete("/stream/session/{sessionID}", streamHandler.StopSessionHandler)

			// Subtitles
			r.Get("/subtitle/list/*", subtitleHandler.ListSubtitles)
			r.Get("/subtitle/content/*", subtitleHandler.ServeSubtitle)
			r.Post("/subtitle/generate/*", subtitleHandler.GenerateSubtitle)
			r.Post("/subtitle/translate/*", subtitleHandler.TranslateSubtitle)

			// Jobs
			r.Get("/jobs", jobHandler.ListJobs)
			r.Get("/jobs/{id}", jobHandler.GetJob)
			r.Delete("/jobs/{id}", jobHandler.CancelJob)

			// Settings (admin only for now, TODO: add role check)
			r.Get("/settings", settingsHandler.GetSettings)
			r.Put("/settings", settingsHandler.UpdateSettings)

			// User
			r.Put("/user/history/*", userHandler.SavePosition)
			r.Get("/user/history/*", userHandler.GetPosition)
		})
	})

	return r
}
