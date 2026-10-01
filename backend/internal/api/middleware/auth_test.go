package middleware

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/video-stream/backend/internal/auth"
	"github.com/video-stream/backend/internal/db"
)

func TestSessionsRevokedAfterAccountChanges(t *testing.T) {
	for _, change := range []string{"password", "role", "delete"} {
		t.Run(change, func(t *testing.T) {
			database, err := db.NewSQLite(filepath.Join(t.TempDir(), "test.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer database.Close()
			id, err := database.CreateUser("owner", "old-hash", "admin")
			if err != nil {
				t.Fatal(err)
			}
			jwt := auth.NewJWTService("test-secret")
			token, err := jwt.GenerateToken(id, "owner", "admin", 0)
			if err != nil {
				t.Fatal(err)
			}
			h := AuthMiddleware(jwt, database)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
			status := func(tok string) int {
				r := httptest.NewRequest("GET", "/", nil)
				r.Header.Set("Authorization", "Bearer "+tok)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				return w.Code
			}
			if status(token) != 204 {
				t.Fatal("fresh session rejected")
			}
			switch change {
			case "password":
				err = database.UpdateUserPassword(id, "new-hash")
			case "role":
				err = database.UpdateUser(id, "owner", "user")
			case "delete":
				err = database.DeleteUser(id)
			}
			if err != nil {
				t.Fatal(err)
			}
			if status(token) != 401 {
				t.Fatal("revoked session still accepted")
			}
			if change != "delete" {
				user, err := database.GetUserByID(id)
				if err != nil {
					t.Fatal(err)
				}
				token, err = jwt.GenerateToken(id, user.Username, user.Role, user.AuthVersion)
				if err != nil || status(token) != 204 {
					t.Fatal("new login rejected", err)
				}
			}
		})
	}
}
