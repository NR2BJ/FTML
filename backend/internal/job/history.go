package job

import (
	"fmt"
	"strings"
	"time"
)

const jobColumns = "id, type, status, file_path, params, progress, result, error, created_at, started_at, completed_at, parent_id, retry_of"

type VideoHistory struct {
	FilePath      string    `json:"file_path"`
	Total         int       `json:"total"`
	Completed     int       `json:"completed"`
	Failed        int       `json:"failed"`
	Active        int       `json:"active"`
	LastCreatedAt time.Time `json:"last_created_at"`
}

type VideoHistoryPage struct {
	Items    []VideoHistory `json:"items"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"page_size"`
}

func (q *JobQueue) VideoHistory(search, status string, page int) (VideoHistoryPage, error) {
	result := VideoHistoryPage{Items: []VideoHistory{}, Page: page, PageSize: 30}
	having := ""
	switch status {
	case "", "all":
	case "active":
		having = " HAVING active > 0"
	case "completed":
		having = " HAVING completed > 0"
	case "failed":
		having = " HAVING failed > 0"
	default:
		return result, fmt.Errorf("잘못된 상태 필터")
	}
	group := `SELECT file_path, COUNT(*) AS total,
		SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed,
		SUM(status IN ('pending','running')) AS active
		FROM jobs WHERE instr(lower(file_path), lower(?)) > 0 GROUP BY file_path` + having
	if err := q.db.QueryRow("SELECT COUNT(*) FROM ("+group+")", search).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := q.db.Query(`WITH grouped AS (`+group+`)
		SELECT g.file_path, g.total, g.completed, g.failed, g.active, j.created_at
		FROM grouped g JOIN jobs j ON j.id = (SELECT id FROM jobs WHERE file_path = g.file_path ORDER BY created_at DESC, id DESC LIMIT 1)
		ORDER BY j.created_at DESC, g.file_path LIMIT ? OFFSET ?`, search, result.PageSize, (page-1)*result.PageSize)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var item VideoHistory
		if err := rows.Scan(&item.FilePath, &item.Total, &item.Completed, &item.Failed, &item.Active, &item.LastCreatedAt); err != nil {
			return result, err
		}
		result.Items = append(result.Items, item)
	}
	return result, rows.Err()
}

func (q *JobQueue) HistoryForVideo(path string, page int) ([]*Job, int, error) {
	var total int
	if err := q.db.QueryRow("SELECT COUNT(*) FROM jobs WHERE file_path = ?", path).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := q.db.Query("SELECT "+jobColumns+" FROM jobs WHERE file_path = ? ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET ?", path, (page-1)*50)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	jobs, err := q.scanJobs(rows)
	if jobs == nil {
		jobs = []*Job{}
	}
	return jobs, total, err
}

func (q *JobQueue) TrackedJobs(ids []string) ([]*Job, error) {
	if len(ids) == 0 || len(ids) > 200 {
		return nil, fmt.Errorf("작업은 1~200개까지 조회할 수 있습니다")
	}
	marks := strings.TrimRight(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)*2)
	for n := 0; n < 2; n++ {
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := q.db.Query("SELECT "+jobColumns+" FROM jobs WHERE id IN ("+marks+") OR parent_id IN ("+marks+") ORDER BY created_at, id", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs, err := q.scanJobs(rows)
	if jobs == nil {
		jobs = []*Job{}
	}
	return jobs, err
}
