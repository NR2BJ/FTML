package api

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"time"

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

	// Rate limiters
	authLimiter := middleware.NewRateLimiter(5, time.Minute) // 5 req/min for login/register

	// Global middleware
	r.Use(chimw.Recoverer)
	r.Use(chimw.RealIP)
	r.Use(middleware.Logger)
	r.Use(cors.Handler(middleware.CORSHandler(cfg.CORSOrigins)))

	// JSON body size limit (1MB) for all non-upload routes
	r.Use(middleware.MaxBodySize(1 << 20))

	// Handlers
	authHandler := handlers.NewAuthHandler(database, jwtService)
	filesHandler := handlers.NewFilesHandler(cfg.MediaPath, cfg.DataPath, database)
	hlsManager := ffmpeg.NewHLSManager(cfg.DataPath)
	streamHandler := handlers.NewStreamHandler(cfg.MediaPath, hlsManager)
	userHandler := handlers.NewUserHandler(database)
	subtitleHandler := handlers.NewSubtitleHandler(cfg.MediaPath, cfg.SubtitlePath, jobQueue, database)
	jobHandler := handlers.NewJobHandler(jobQueue)
	settingsHandler := handlers.NewSettingsHandler(database)
	whisperModelsHandler := handlers.NewWhisperModelsHandler(database)
	presetsHandler := handlers.NewPresetsHandler(database)
	whisperBackendsHandler := handlers.NewWhisperBackendsHandler(database)
	geminiModelsHandler := handlers.NewGeminiModelsHandler(database)
	adminHandler := handlers.NewAdminHandler(database, hlsManager, cfg.MediaPath)

	// Internal routes — localhost only, no auth (container-to-container / Docker CLI)
	r.Route("/internal", func(r chi.Router) {
		r.Use(localhostOnly)
		r.Get("/whisper/active-model", whisperModelsHandler.GetActiveModel)

		// Rate limit management — accessible only from localhost (Docker exec, SSH, Portainer console)
		r.Get("/ratelimit", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(authLimiter.Status())
		})
		r.Delete("/ratelimit", func(w http.ResponseWriter, r *http.Request) {
			authLimiter.Clear()
			log.Println("[ratelimit] All rate limits cleared via internal API")
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"message":"all rate limits cleared"}`))
		})
		r.Delete("/ratelimit/{ip}", func(w http.ResponseWriter, r *http.Request) {
			ip := chi.URLParam(r, "ip")
			if authLimiter.ClearIP(ip) {
				log.Printf("[ratelimit] Rate limit cleared for IP %s via internal API", ip)
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"message":"rate limit cleared for ` + ip + `"}`))
			} else {
				w.WriteHeader(http.StatusNotFound)
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"error":"IP not found in rate limit table"}`))
			}
		})
	})

	// Public routes
	r.Route("/api", func(r chi.Router) {
		// Health check (no auth)
		r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"status":"ok"}`))
		})

		// Auth (public, rate limited)
		r.Group(func(r chi.Router) {
			r.Use(authLimiter.Handler)
			r.Post("/auth/login", authHandler.Login)
			r.Post("/auth/register", authHandler.Register)
		})

		// Protected routes — all authenticated users (viewer, editor, admin)
		r.Group(func(r chi.Router) {
			r.Use(middleware.AuthMiddleware(jwtService))

			// Auth
			r.Get("/auth/me", authHandler.Me)

			// Files — read-only
			r.Get("/files/tree", filesHandler.GetTree)
			r.Get("/files/tree/*", filesHandler.GetTree)
			r.Get("/files/info/*", filesHandler.GetInfo)
			r.Get("/files/thumbnail/*", filesHandler.GetThumbnail)
			r.Get("/files/search", filesHandler.Search)
			r.Post("/files/batch-info", filesHandler.BatchInfo)
			r.Get("/files/siblings/*", filesHandler.GetSiblings)

			// Streaming
			r.Get("/stream/capabilities", streamHandler.CapabilitiesHandler)
			r.Get("/stream/presets/*", streamHandler.PresetsHandler)
			r.Get("/stream/hls/*", streamHandler.HLSHandler)
			r.Get("/stream/direct/*", streamHandler.DirectPlay)
			r.Post("/stream/heartbeat/{sessionID}", streamHandler.HeartbeatHandler)
			r.Post("/stream/pause/{sessionID}", streamHandler.PauseHandler)
			r.Post("/stream/resume/{sessionID}", streamHandler.ResumeHandler)
			r.Delete("/stream/session/{sessionID}", streamHandler.StopSessionHandler)

			// Subtitles — read-only
			r.Get("/subtitle/list/*", subtitleHandler.ListSubtitles)
			r.Get("/subtitle/content/*", subtitleHandler.ServeSubtitle)

			// Jobs — read-only
			r.Get("/jobs", jobHandler.ListJobs)
			r.Get("/jobs/{id}", jobHandler.GetJob)

			// User self-service
			r.Get("/user/history", userHandler.ListHistory)
			r.Put("/user/history/*", userHandler.SavePosition)
			r.Get("/user/history/*", userHandler.GetPosition)
			r.Delete("/user/history/*", userHandler.DeleteHistory)
			r.Put("/user/password", userHandler.ChangePassword)

			// Whisper backends — available list for dropdown (read-only)
			r.Get("/whisper/backends/available", whisperBackendsHandler.ListAvailable)

			// Editor+ routes (admin, editor)
			r.Group(func(r chi.Router) {
				r.Use(middleware.RequireRole("admin", "editor"))

				r.Post("/subtitle/generate/*", subtitleHandler.GenerateSubtitle)
				r.Post("/subtitle/translate/*", subtitleHandler.TranslateSubtitle)
				r.Delete("/subtitle/delete/*", subtitleHandler.DeleteSubtitle)
				r.Post("/subtitle/upload/*", subtitleHandler.UploadSubtitle)
				r.Post("/subtitle/batch-generate", subtitleHandler.BatchGenerate)
				r.Post("/subtitle/batch-translate", subtitleHandler.BatchTranslate)
				r.Post("/subtitle/convert/*", subtitleHandler.ConvertSubtitle)
				r.Delete("/jobs/{id}", jobHandler.CancelJob)
				r.Post("/jobs/{id}/retry", jobHandler.RetryJob)
			})

			// Admin-only routes
			r.Group(func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))

				// Settings
				r.Get("/settings", settingsHandler.GetSettings)
				r.Put("/settings", settingsHandler.UpdateSettings)

				// Whisper Model Management
				r.Get("/whisper/models", whisperModelsHandler.ListModels)
				r.Post("/whisper/models/active", whisperModelsHandler.SetActiveModel)

				// GPU Info
				r.Get("/gpu/info", whisperModelsHandler.GPUInfo)

				// Translation Presets
				r.Get("/presets", presetsHandler.ListPresets)
				r.Post("/presets", presetsHandler.CreatePreset)
				r.Delete("/presets/{id}", presetsHandler.DeletePreset)

				// Gemini Models
				r.Get("/gemini/models", geminiModelsHandler.ListModels)

				// Whisper Backends — full CRUD
				r.Get("/whisper/backends", whisperBackendsHandler.ListBackends)
				r.Post("/whisper/backends", whisperBackendsHandler.CreateBackend)
				r.Put("/whisper/backends/{id}", whisperBackendsHandler.UpdateBackend)
				r.Delete("/whisper/backends/{id}", whisperBackendsHandler.DeleteBackend)
				r.Post("/whisper/backends/{id}/health", whisperBackendsHandler.HealthCheck)

				// Admin — User Management
				r.Get("/admin/users", adminHandler.ListUsers)
				r.Post("/admin/users", adminHandler.CreateUser)
				r.Put("/admin/users/{id}", adminHandler.UpdateUser)
				r.Delete("/admin/users/{id}", adminHandler.DeleteUser)
				r.Get("/admin/users/{id}/history", adminHandler.GetUserHistory)

				// Admin — Registration Management
				r.Get("/admin/registrations", adminHandler.ListRegistrations)
				r.Get("/admin/registrations/count", adminHandler.PendingRegistrationCount)
				r.Post("/admin/registrations/{id}/approve", adminHandler.ApproveRegistration)
				r.Post("/admin/registrations/{id}/reject", adminHandler.RejectRegistration)
				r.Delete("/admin/registrations/{id}", adminHandler.DeleteRegistration)

				// Admin — File Management (upload uses its own body limit)
				r.Post("/files/upload/*", filesHandler.Upload)
				r.Delete("/files/delete/*", filesHandler.Delete)
				r.Put("/files/move", filesHandler.Move)
				r.Post("/files/mkdir/*", filesHandler.CreateFolder)

				// Admin — Trash Management
				r.Get("/files/trash", filesHandler.ListTrash)
				r.Post("/files/trash/restore", filesHandler.RestoreTrash)
				r.Delete("/files/trash/empty", filesHandler.EmptyTrash)
				r.Delete("/files/trash/{name}", filesHandler.PermanentDelete)

				// Admin — Active Sessions
				r.Get("/admin/sessions", adminHandler.ListSessions)

				// Admin — Dashboard Stats
				r.Get("/admin/dashboard", adminHandler.DashboardStats)

				// Admin — File Logs
				r.Get("/admin/file-logs", adminHandler.ListFileLogs)

				// Admin — Rate Limit Management
				r.Get("/admin/ratelimit", func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(authLimiter.Status())
				})
				r.Delete("/admin/ratelimit", func(w http.ResponseWriter, r *http.Request) {
					authLimiter.Clear()
					w.Header().Set("Content-Type", "application/json")
					w.Write([]byte(`{"message":"rate limit cleared"}`))
				})
				r.Delete("/admin/ratelimit/{ip}", func(w http.ResponseWriter, r *http.Request) {
					ip := chi.URLParam(r, "ip")
					if authLimiter.ClearIP(ip) {
						w.Header().Set("Content-Type", "application/json")
						w.Write([]byte(`{"message":"rate limit cleared for ` + ip + `"}`))
					} else {
						w.WriteHeader(http.StatusNotFound)
						w.Header().Set("Content-Type", "application/json")
						w.Write([]byte(`{"error":"IP not found in rate limit table"}`))
					}
				})
			})
		})
	})

	return r
}

// localhostOnly is a middleware that rejects requests not from localhost.
// Used for internal management endpoints accessible only from Docker exec, SSH, etc.
func localhostOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		ip := net.ParseIP(host)
		if ip == nil || (!ip.IsLoopback() && host != "::1") {
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"error":"internal endpoints are only accessible from localhost"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}
