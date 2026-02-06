package db

import (
	"database/sql"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/db/models"
)

type Database struct {
	db *sql.DB
}

func NewSQLite(path string) (*Database, error) {
	sqlDB, err := sql.Open("sqlite3", path+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}
	d := &Database{db: sqlDB}
	if err := d.migrate(); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *Database) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		password TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'viewer',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS watch_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		file_path TEXT NOT NULL,
		position REAL NOT NULL DEFAULT 0,
		duration REAL NOT NULL DEFAULT 0,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id),
		UNIQUE(user_id, file_path)
	);
	`
	_, err := d.db.Exec(schema)
	return err
}

func (d *Database) EnsureAdmin(username, password string) error {
	var count int
	err := d.db.QueryRow("SELECT COUNT(*) FROM users WHERE role = 'admin'").Scan(&count)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	_, err = d.db.Exec(
		"INSERT INTO users (username, password, role) VALUES (?, ?, 'admin')",
		username, hash,
	)
	return err
}

func (d *Database) GetUserByUsername(username string) (*models.User, error) {
	u := &models.User{}
	err := d.db.QueryRow(
		"SELECT id, username, password, role, created_at, updated_at FROM users WHERE username = ?",
		username,
	).Scan(&u.ID, &u.Username, &u.Password, &u.Role, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (d *Database) GetUserByID(id int64) (*models.User, error) {
	u := &models.User{}
	err := d.db.QueryRow(
		"SELECT id, username, password, role, created_at, updated_at FROM users WHERE id = ?",
		id,
	).Scan(&u.ID, &u.Username, &u.Password, &u.Role, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (d *Database) SaveWatchPosition(userID int64, filePath string, position, duration float64) error {
	_, err := d.db.Exec(`
		INSERT INTO watch_history (user_id, file_path, position, duration, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(user_id, file_path) DO UPDATE SET position=?, duration=?, updated_at=?`,
		userID, filePath, position, duration, time.Now(),
		position, duration, time.Now(),
	)
	return err
}

func (d *Database) GetWatchPosition(userID int64, filePath string) (float64, error) {
	var pos float64
	err := d.db.QueryRow(
		"SELECT position FROM watch_history WHERE user_id = ? AND file_path = ?",
		userID, filePath,
	).Scan(&pos)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return pos, err
}

func (d *Database) Close() error {
	return d.db.Close()
}
