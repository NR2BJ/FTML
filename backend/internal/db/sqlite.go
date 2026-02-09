package db

import (
	"database/sql"
	"fmt"
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
		role TEXT NOT NULL DEFAULT 'user',
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

	CREATE TABLE IF NOT EXISTS registrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		password TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		reviewed_at DATETIME,
		reviewed_by INTEGER,
		FOREIGN KEY (reviewed_by) REFERENCES users(id)
	);

	CREATE TABLE IF NOT EXISTS delete_requests (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		username TEXT NOT NULL,
		video_path TEXT NOT NULL,
		subtitle_id TEXT NOT NULL,
		subtitle_label TEXT NOT NULL DEFAULT '',
		reason TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'pending',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		reviewed_at DATETIME,
		reviewed_by INTEGER,
		FOREIGN KEY (user_id) REFERENCES users(id),
		FOREIGN KEY (reviewed_by) REFERENCES users(id)
	);

	CREATE TABLE IF NOT EXISTS file_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		username TEXT NOT NULL,
		action TEXT NOT NULL,
		file_path TEXT NOT NULL,
		detail TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`
	if _, err := d.db.Exec(schema); err != nil {
		return err
	}
	d.migrateWhisperBackends()
	// Migrate legacy roles: viewer/editor → user
	d.db.Exec("UPDATE users SET role = 'user' WHERE role IN ('viewer', 'editor')")
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

// --- User CRUD ---

// ListUsers returns all users ordered by creation time
func (d *Database) ListUsers() ([]models.User, error) {
	rows, err := d.db.Query("SELECT id, username, password, role, created_at, updated_at FROM users ORDER BY created_at ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Username, &u.Password, &u.Role, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	if users == nil {
		users = []models.User{}
	}
	return users, nil
}

// CreateUser inserts a new user with hashed password
func (d *Database) CreateUser(username, hashedPassword, role string) (int64, error) {
	result, err := d.db.Exec(
		"INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
		username, hashedPassword, role,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// UpdateUser updates username and role for a user
func (d *Database) UpdateUser(id int64, username, role string) error {
	_, err := d.db.Exec(
		"UPDATE users SET username = ?, role = ?, updated_at = ? WHERE id = ?",
		username, role, time.Now(), id,
	)
	return err
}

// UpdateUserPassword updates a user's password
func (d *Database) UpdateUserPassword(id int64, hashedPassword string) error {
	_, err := d.db.Exec(
		"UPDATE users SET password = ?, updated_at = ? WHERE id = ?",
		hashedPassword, time.Now(), id,
	)
	return err
}

// DeleteUser removes a user and their watch history
func (d *Database) DeleteUser(id int64) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec("DELETE FROM watch_history WHERE user_id = ?", id); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM users WHERE id = ?", id); err != nil {
		return err
	}
	return tx.Commit()
}

// CountAdmins returns the number of admin users
func (d *Database) CountAdmins() (int, error) {
	var count int
	err := d.db.QueryRow("SELECT COUNT(*) FROM users WHERE role = 'admin'").Scan(&count)
	return count, err
}

// --- Watch History ---

// ListWatchHistory returns all watch history entries for a user, sorted by most recent
func (d *Database) ListWatchHistory(userID int64) ([]models.WatchHistoryEntry, error) {
	rows, err := d.db.Query(
		"SELECT file_path, position, duration, updated_at FROM watch_history WHERE user_id = ? ORDER BY updated_at DESC",
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []models.WatchHistoryEntry
	for rows.Next() {
		var e models.WatchHistoryEntry
		if err := rows.Scan(&e.FilePath, &e.Position, &e.Duration, &e.UpdatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	if entries == nil {
		entries = []models.WatchHistoryEntry{}
	}
	return entries, nil
}

// DeleteWatchHistory removes a specific watch history entry
func (d *Database) DeleteWatchHistory(userID int64, filePath string) error {
	_, err := d.db.Exec("DELETE FROM watch_history WHERE user_id = ? AND file_path = ?", userID, filePath)
	return err
}

// --- Registration ---

// CreateRegistration inserts a pending registration request
func (d *Database) CreateRegistration(username, hashedPassword string) (int64, error) {
	result, err := d.db.Exec(
		"INSERT INTO registrations (username, password) VALUES (?, ?)",
		username, hashedPassword,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// ListRegistrations returns registrations filtered by status (empty = all)
func (d *Database) ListRegistrations(status string) ([]models.Registration, error) {
	var query string
	var args []interface{}
	if status != "" {
		query = "SELECT id, username, status, created_at, reviewed_at, reviewed_by FROM registrations WHERE status = ? ORDER BY created_at DESC"
		args = append(args, status)
	} else {
		query = "SELECT id, username, status, created_at, reviewed_at, reviewed_by FROM registrations ORDER BY created_at DESC"
	}

	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var regs []models.Registration
	for rows.Next() {
		var r models.Registration
		if err := rows.Scan(&r.ID, &r.Username, &r.Status, &r.CreatedAt, &r.ReviewedAt, &r.ReviewedBy); err != nil {
			return nil, err
		}
		regs = append(regs, r)
	}
	if regs == nil {
		regs = []models.Registration{}
	}
	return regs, nil
}

// GetRegistration returns a single registration by ID
func (d *Database) GetRegistration(id int64) (*models.Registration, error) {
	var r models.Registration
	err := d.db.QueryRow(
		"SELECT id, username, status, created_at, reviewed_at, reviewed_by FROM registrations WHERE id = ?", id,
	).Scan(&r.ID, &r.Username, &r.Status, &r.CreatedAt, &r.ReviewedAt, &r.ReviewedBy)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// GetRegistrationPassword returns the hashed password for a registration (needed for approval)
func (d *Database) GetRegistrationPassword(id int64) (string, error) {
	var password string
	err := d.db.QueryRow("SELECT password FROM registrations WHERE id = ?", id).Scan(&password)
	return password, err
}

// ApproveRegistration marks a registration as approved and creates the user
func (d *Database) ApproveRegistration(id int64, reviewerID int64) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Get registration details
	var username, password string
	err = tx.QueryRow("SELECT username, password FROM registrations WHERE id = ? AND status = 'pending'", id).Scan(&username, &password)
	if err != nil {
		return err
	}

	// Create user with viewer role
	_, err = tx.Exec("INSERT INTO users (username, password, role) VALUES (?, ?, 'viewer')", username, password)
	if err != nil {
		return err
	}

	// Update registration status
	now := time.Now()
	_, err = tx.Exec("UPDATE registrations SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ?", now, reviewerID, id)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// RejectRegistration marks a registration as rejected
func (d *Database) RejectRegistration(id int64, reviewerID int64) error {
	now := time.Now()
	_, err := d.db.Exec(
		"UPDATE registrations SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'",
		now, reviewerID, id,
	)
	return err
}

// --- Registration Delete ---

// DeleteRegistration removes a non-pending registration record
func (d *Database) DeleteRegistration(id int64) error {
	result, err := d.db.Exec("DELETE FROM registrations WHERE id = ? AND status != 'pending'", id)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// --- File Logs ---

// FileLog represents a file operation log entry
type FileLog struct {
	ID        int64  `json:"id"`
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
	Action    string `json:"action"`
	FilePath  string `json:"file_path"`
	Detail    string `json:"detail"`
	CreatedAt string `json:"created_at"`
}

// CreateFileLog records a file operation
func (d *Database) CreateFileLog(userID int64, username, action, filePath, detail string) error {
	_, err := d.db.Exec(
		"INSERT INTO file_logs (user_id, username, action, file_path, detail) VALUES (?, ?, ?, ?, ?)",
		userID, username, action, filePath, detail,
	)
	return err
}

// ListFileLogs returns the most recent file operation logs
func (d *Database) ListFileLogs(limit int) ([]FileLog, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := d.db.Query(
		"SELECT id, user_id, username, action, file_path, COALESCE(detail, ''), created_at FROM file_logs ORDER BY created_at DESC LIMIT ?",
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var logs []FileLog
	for rows.Next() {
		var l FileLog
		if err := rows.Scan(&l.ID, &l.UserID, &l.Username, &l.Action, &l.FilePath, &l.Detail, &l.CreatedAt); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	if logs == nil {
		logs = []FileLog{}
	}
	return logs, nil
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

// --- Delete Requests ---

// CreateDeleteRequest inserts a new subtitle delete request (checks for duplicate pending)
func (d *Database) CreateDeleteRequest(userID int64, username, videoPath, subtitleID, subtitleLabel, reason string) (int64, error) {
	var count int
	d.db.QueryRow(
		"SELECT COUNT(*) FROM delete_requests WHERE video_path = ? AND subtitle_id = ? AND status = 'pending'",
		videoPath, subtitleID,
	).Scan(&count)
	if count > 0 {
		return 0, fmt.Errorf("a pending delete request already exists for this subtitle")
	}
	result, err := d.db.Exec(
		"INSERT INTO delete_requests (user_id, username, video_path, subtitle_id, subtitle_label, reason) VALUES (?, ?, ?, ?, ?, ?)",
		userID, username, videoPath, subtitleID, subtitleLabel, reason,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// ListDeleteRequests returns delete requests filtered by status
func (d *Database) ListDeleteRequests(status string) ([]models.DeleteRequest, error) {
	var query string
	var args []interface{}
	if status != "" {
		query = "SELECT id, user_id, username, video_path, subtitle_id, subtitle_label, COALESCE(reason,''), status, created_at, reviewed_at, reviewed_by FROM delete_requests WHERE status = ? ORDER BY created_at DESC"
		args = append(args, status)
	} else {
		query = "SELECT id, user_id, username, video_path, subtitle_id, subtitle_label, COALESCE(reason,''), status, created_at, reviewed_at, reviewed_by FROM delete_requests ORDER BY created_at DESC"
	}
	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reqs []models.DeleteRequest
	for rows.Next() {
		var r models.DeleteRequest
		if err := rows.Scan(&r.ID, &r.UserID, &r.Username, &r.VideoPath, &r.SubtitleID, &r.SubtitleLabel, &r.Reason, &r.Status, &r.CreatedAt, &r.ReviewedAt, &r.ReviewedBy); err != nil {
			return nil, err
		}
		reqs = append(reqs, r)
	}
	if reqs == nil {
		reqs = []models.DeleteRequest{}
	}
	return reqs, nil
}

// ListUserDeleteRequests returns delete requests for a specific user
func (d *Database) ListUserDeleteRequests(userID int64) ([]models.DeleteRequest, error) {
	rows, err := d.db.Query(
		"SELECT id, user_id, username, video_path, subtitle_id, subtitle_label, COALESCE(reason,''), status, created_at, reviewed_at, reviewed_by FROM delete_requests WHERE user_id = ? ORDER BY created_at DESC",
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reqs []models.DeleteRequest
	for rows.Next() {
		var r models.DeleteRequest
		if err := rows.Scan(&r.ID, &r.UserID, &r.Username, &r.VideoPath, &r.SubtitleID, &r.SubtitleLabel, &r.Reason, &r.Status, &r.CreatedAt, &r.ReviewedAt, &r.ReviewedBy); err != nil {
			return nil, err
		}
		reqs = append(reqs, r)
	}
	if reqs == nil {
		reqs = []models.DeleteRequest{}
	}
	return reqs, nil
}

// GetDeleteRequest returns a single delete request by ID
func (d *Database) GetDeleteRequest(id int64) (*models.DeleteRequest, error) {
	var r models.DeleteRequest
	err := d.db.QueryRow(
		"SELECT id, user_id, username, video_path, subtitle_id, subtitle_label, COALESCE(reason,''), status, created_at, reviewed_at, reviewed_by FROM delete_requests WHERE id = ?", id,
	).Scan(&r.ID, &r.UserID, &r.Username, &r.VideoPath, &r.SubtitleID, &r.SubtitleLabel, &r.Reason, &r.Status, &r.CreatedAt, &r.ReviewedAt, &r.ReviewedBy)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// ApproveDeleteRequest marks a delete request as approved
func (d *Database) ApproveDeleteRequest(id int64, reviewerID int64) error {
	now := time.Now()
	result, err := d.db.Exec(
		"UPDATE delete_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'",
		now, reviewerID, id,
	)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// RejectDeleteRequest marks a delete request as rejected
func (d *Database) RejectDeleteRequest(id int64, reviewerID int64) error {
	now := time.Now()
	result, err := d.db.Exec(
		"UPDATE delete_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'",
		now, reviewerID, id,
	)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// DeleteDeleteRequest removes a non-pending delete request record
func (d *Database) DeleteDeleteRequest(id int64) error {
	result, err := d.db.Exec("DELETE FROM delete_requests WHERE id = ? AND status != 'pending'", id)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// CountPendingDeleteRequests returns the count of pending delete requests
func (d *Database) CountPendingDeleteRequests() (int, error) {
	var count int
	err := d.db.QueryRow("SELECT COUNT(*) FROM delete_requests WHERE status = 'pending'").Scan(&count)
	return count, err
}
