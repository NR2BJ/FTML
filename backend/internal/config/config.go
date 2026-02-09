package config

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port          int
	MediaPath     string
	DataPath      string
	DBPath        string
	JWTSecret     string
	AdminUsername  string
	AdminPassword string
	SubtitlePath  string
	CORSOrigins   []string
}

func Load() *Config {
	port, _ := strconv.Atoi(getEnv("PORT", "8080"))
	dataPath := getEnv("DATA_PATH", "/data")

	// JWT secret: require explicit setting or generate random
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			log.Fatalf("Failed to generate random JWT secret: %v", err)
		}
		jwtSecret = hex.EncodeToString(b)
		log.Println("WARNING: JWT_SECRET not set, using random secret. Sessions will not survive restarts. Set JWT_SECRET env var for persistent sessions.")
	}

	// CORS origins: comma-separated list or "*" (default)
	corsOrigins := []string{"*"}
	if v := os.Getenv("CORS_ORIGINS"); v != "" {
		origins := strings.Split(v, ",")
		corsOrigins = make([]string, 0, len(origins))
		for _, o := range origins {
			o = strings.TrimSpace(o)
			if o != "" {
				corsOrigins = append(corsOrigins, o)
			}
		}
	}

	return &Config{
		Port:          port,
		MediaPath:     getEnv("MEDIA_PATH", "/media"),
		DataPath:      dataPath,
		DBPath:        getEnv("DB_PATH", dataPath+"/videostream.db"),
		JWTSecret:     jwtSecret,
		AdminUsername:  getEnv("ADMIN_USERNAME", "admin"),
		AdminPassword: getEnv("ADMIN_PASSWORD", "admin"),
		SubtitlePath:  getEnv("SUBTITLE_PATH", dataPath+"/subtitles"),
		CORSOrigins:   corsOrigins,
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
