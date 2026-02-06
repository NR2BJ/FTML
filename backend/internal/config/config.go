package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port          int
	MediaPath     string
	DataPath      string
	DBPath        string
	JWTSecret     string
	AdminUsername  string
	AdminPassword string
}

func Load() *Config {
	port, _ := strconv.Atoi(getEnv("PORT", "8080"))
	return &Config{
		Port:          port,
		MediaPath:     getEnv("MEDIA_PATH", "/media"),
		DataPath:      getEnv("DATA_PATH", "/data"),
		DBPath:        getEnv("DB_PATH", "/data/videostream.db"),
		JWTSecret:     getEnv("JWT_SECRET", "dev-secret-change-me"),
		AdminUsername:  getEnv("ADMIN_USERNAME", "admin"),
		AdminPassword: getEnv("ADMIN_PASSWORD", "admin"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
