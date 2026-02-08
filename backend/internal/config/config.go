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
	SubtitlePath string
}

func Load() *Config {
	port, _ := strconv.Atoi(getEnv("PORT", "8080"))
	dataPath := getEnv("DATA_PATH", "/data")
	return &Config{
		Port:          port,
		MediaPath:     getEnv("MEDIA_PATH", "/media"),
		DataPath:      dataPath,
		DBPath:        getEnv("DB_PATH", dataPath+"/videostream.db"),
		JWTSecret:     getEnv("JWT_SECRET", "dev-secret-change-me"),
		AdminUsername:  getEnv("ADMIN_USERNAME", "admin"),
		AdminPassword: getEnv("ADMIN_PASSWORD", "admin"),
		SubtitlePath: getEnv("SUBTITLE_PATH", dataPath+"/subtitles"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
