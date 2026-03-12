package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/video-stream/backend/internal/api"
	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/config"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/ffmpeg"
	"github.com/video-stream/backend/internal/job"
	"github.com/video-stream/backend/internal/subtitle/translate"
	"github.com/video-stream/backend/internal/subtitle/whisper"
)

func main() {
	cfg := config.Load()

	// Ensure data directory exists
	if err := os.MkdirAll(cfg.DataPath, 0755); err != nil {
		log.Fatalf("Failed to create data directory %s: %v", cfg.DataPath, err)
	}

	// Initialize database
	database, err := db.NewSQLite(cfg.DBPath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer database.Close()

	// Ensure admin user exists
	if err := database.EnsureAdmin(cfg.AdminUsername, cfg.AdminPassword); err != nil {
		log.Fatalf("Failed to create admin user: %v", err)
	}
	log.Printf("Admin user ensured: %s", cfg.AdminUsername)

	// Detect GPU hardware capabilities
	caps := ffmpeg.DetectHardware()
	encoderNames := make([]string, len(caps.Encoders))
	for i, enc := range caps.Encoders {
		encoderNames[i] = enc.Encoder
	}
	log.Printf("GPU detection: hwaccel=%s device=%s encoders=[%s]", caps.HWAccel, caps.Device, strings.Join(encoderNames, ", "))

	// Initialize JWT service
	jwtService := auth.NewJWTService(cfg.JWTSecret)

	// Initialize job queue
	jobQueue := job.NewJobQueue(database.DB())
	defer jobQueue.Stop()
	log.Printf("Job queue started")

	// Initialize whisper service (dynamically resolves backends from DB)
	whisperSvc := whisper.NewService(cfg.MediaPath, cfg.SubtitlePath, database)
	jobQueue.RegisterHandler(job.JobTranscribe, whisperSvc.HandleJob)

	// Initialize translation service and register with job queue
	// Gemini model is resolved dynamically from DB so changes take effect immediately
	geminiModelResolver := func() string {
		return database.GetSetting("gemini_model", "gemini-2.0-flash")
	}
	translateSvc := translate.NewService(cfg.MediaPath, cfg.SubtitlePath, database, geminiModelResolver)
	jobQueue.RegisterHandler(job.JobTranslate, translateSvc.HandleJob)

	// Create router
	router := api.NewRouter(database, jwtService, cfg, jobQueue)

	// Start server
	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("Starting server on %s", addr)
	log.Printf("Media path: %s", cfg.MediaPath)

	server := &http.Server{
		Addr:              addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1MB
		// ReadTimeout and WriteTimeout intentionally not set — HLS streaming needs long-lived connections
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := server.Shutdown(ctx); err != nil {
			log.Printf("Graceful shutdown failed: %v", err)
		}
	}()

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server failed: %v", err)
	}
}
