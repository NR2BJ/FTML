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

	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS jobs (
		id TEXT PRIMARY KEY,
		type TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		file_path TEXT NOT NULL,
		params TEXT NOT NULL,
		progress REAL DEFAULT 0,
		result TEXT,
		error TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		started_at DATETIME,
		completed_at DATETIME
	);

	CREATE TABLE IF NOT EXISTS translation_presets (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		prompt TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS whisper_backends (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		backend_type TEXT NOT NULL,
		url TEXT NOT NULL DEFAULT '',
		enabled INTEGER NOT NULL DEFAULT 1,
		priority INTEGER NOT NULL DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`
	if _, err := d.db.Exec(schema); err != nil {
		return err
	}
	d.migrateWhisperBackends()
	return nil
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

// GetSetting returns a setting value by key, or defaultVal if not found
func (d *Database) GetSetting(key, defaultVal string) string {
	var val string
	err := d.db.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&val)
	if err != nil {
		return defaultVal
	}
	return val
}

// SetSetting upserts a setting
func (d *Database) SetSetting(key, value string) error {
	_, err := d.db.Exec(`
		INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`,
		key, value, value,
	)
	return err
}

// GetAllSettings returns all settings as a map
func (d *Database) GetAllSettings() (map[string]string, error) {
	rows, err := d.db.Query("SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		result[k] = v
	}
	return result, nil
}

func (d *Database) Close() error {
	return d.db.Close()
}

// DB returns the underlying sql.DB for use by other packages (e.g., job queue)
func (d *Database) DB() *sql.DB {
	return d.db
}

// TranslationPreset represents a saved custom translation prompt
type TranslationPreset struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Prompt    string `json:"prompt"`
	CreatedAt string `json:"created_at"`
}

// ListTranslationPresets returns all saved presets ordered by creation time
func (d *Database) ListTranslationPresets() ([]TranslationPreset, error) {
	rows, err := d.db.Query("SELECT id, name, prompt, created_at FROM translation_presets ORDER BY created_at ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var presets []TranslationPreset
	for rows.Next() {
		var p TranslationPreset
		if err := rows.Scan(&p.ID, &p.Name, &p.Prompt, &p.CreatedAt); err != nil {
			return nil, err
		}
		presets = append(presets, p)
	}
	if presets == nil {
		presets = []TranslationPreset{}
	}
	return presets, nil
}

// CreateTranslationPreset saves a new custom translation preset
func (d *Database) CreateTranslationPreset(name, prompt string) (int64, error) {
	result, err := d.db.Exec(
		"INSERT INTO translation_presets (name, prompt) VALUES (?, ?)",
		name, prompt,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// DeleteTranslationPreset removes a saved preset by ID
func (d *Database) DeleteTranslationPreset(id int64) error {
	_, err := d.db.Exec("DELETE FROM translation_presets WHERE id = ?", id)
	return err
}

// WhisperBackend represents a registered whisper backend (SYCL, OpenVINO, CUDA, etc.)
type WhisperBackend struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	BackendType string `json:"backend_type"`
	URL         string `json:"url"`
	Enabled     bool   `json:"enabled"`
	Priority    int    `json:"priority"`
	CreatedAt   string `json:"created_at"`
}

// ListWhisperBackends returns all backends ordered by priority
func (d *Database) ListWhisperBackends() ([]WhisperBackend, error) {
	rows, err := d.db.Query("SELECT id, name, backend_type, url, enabled, priority, created_at FROM whisper_backends ORDER BY priority ASC, id ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var backends []WhisperBackend
	for rows.Next() {
		var b WhisperBackend
		var enabled int
		if err := rows.Scan(&b.ID, &b.Name, &b.BackendType, &b.URL, &enabled, &b.Priority, &b.CreatedAt); err != nil {
			return nil, err
		}
		b.Enabled = enabled != 0
		backends = append(backends, b)
	}
	if backends == nil {
		backends = []WhisperBackend{}
	}
	return backends, nil
}

// GetWhisperBackend returns a single backend by ID
func (d *Database) GetWhisperBackend(id int64) (*WhisperBackend, error) {
	var b WhisperBackend
	var enabled int
	err := d.db.QueryRow(
		"SELECT id, name, backend_type, url, enabled, priority, created_at FROM whisper_backends WHERE id = ?", id,
	).Scan(&b.ID, &b.Name, &b.BackendType, &b.URL, &enabled, &b.Priority, &b.CreatedAt)
	if err != nil {
		return nil, err
	}
	b.Enabled = enabled != 0
	return &b, nil
}

// CreateWhisperBackend adds a new backend
func (d *Database) CreateWhisperBackend(name, backendType, url string, priority int) (int64, error) {
	result, err := d.db.Exec(
		"INSERT INTO whisper_backends (name, backend_type, url, priority) VALUES (?, ?, ?, ?)",
		name, backendType, url, priority,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// UpdateWhisperBackend modifies an existing backend
func (d *Database) UpdateWhisperBackend(id int64, name, backendType, url string, enabled bool, priority int) error {
	enabledInt := 0
	if enabled {
		enabledInt = 1
	}
	_, err := d.db.Exec(
		"UPDATE whisper_backends SET name=?, backend_type=?, url=?, enabled=?, priority=? WHERE id=?",
		name, backendType, url, enabledInt, priority, id,
	)
	return err
}

// DeleteWhisperBackend removes a backend by ID
func (d *Database) DeleteWhisperBackend(id int64) error {
	_, err := d.db.Exec("DELETE FROM whisper_backends WHERE id = ?", id)
	return err
}

// migrateWhisperBackends seeds the whisper_backends table from legacy settings on first run
func (d *Database) migrateWhisperBackends() {
	var count int
	d.db.QueryRow("SELECT COUNT(*) FROM whisper_backends").Scan(&count)
	if count > 0 {
		return
	}

	whisperURL := d.GetSetting("whisper_url", "")
	if whisperURL != "" {
		d.CreateWhisperBackend("Whisper (Local)", "sycl", whisperURL, 0)
	}
	openAIKey := d.GetSetting("openai_api_key", "")
	if openAIKey != "" {
		d.CreateWhisperBackend("OpenAI Whisper", "openai", "", 10)
	}
}
