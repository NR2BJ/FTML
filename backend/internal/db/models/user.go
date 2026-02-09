package models

import "time"

type User struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	Password  string    `json:"-"`
	Role      string    `json:"role"` // admin, editor, viewer
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// WatchHistoryEntry represents a single watch history record
type WatchHistoryEntry struct {
	FilePath  string    `json:"file_path"`
	Position  float64   `json:"position"`
	Duration  float64   `json:"duration"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Registration represents a pending user registration request
type Registration struct {
	ID         int64      `json:"id"`
	Username   string     `json:"username"`
	Status     string     `json:"status"` // pending, approved, rejected
	CreatedAt  time.Time  `json:"created_at"`
	ReviewedAt *time.Time `json:"reviewed_at,omitempty"`
	ReviewedBy *int64     `json:"reviewed_by,omitempty"`
}

// DeleteRequest represents a user's request to delete a generated subtitle
type DeleteRequest struct {
	ID            int64   `json:"id"`
	UserID        int64   `json:"user_id"`
	Username      string  `json:"username"`
	VideoPath     string  `json:"video_path"`
	SubtitleID    string  `json:"subtitle_id"`
	SubtitleLabel string  `json:"subtitle_label"`
	Reason        string  `json:"reason"`
	Status        string  `json:"status"` // pending, approved, rejected
	CreatedAt     string  `json:"created_at"`
	ReviewedAt    *string `json:"reviewed_at,omitempty"`
	ReviewedBy    *int64  `json:"reviewed_by,omitempty"`
}
