package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/video-stream/backend/internal/api"
	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/config"
	"github.com/video-stream/backend/internal/db"
	"github.com/video-stream/backend/internal/ffmpeg"
)

func main() {
	cfg := config.Load()

	// Ensure data directory exists
	os.MkdirAll(cfg.DataPath, 0755)

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

	// Create router
	router := api.NewRouter(database, jwtService, cfg.MediaPath, cfg.DataPath)

	// Start server
	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("Starting server on %s", addr)
	log.Printf("Media path: %s", cfg.MediaPath)

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		os.Exit(0)
	}()

	if err := http.ListenAndServe(addr, router); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
