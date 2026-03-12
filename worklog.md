# Worklog

## 2026-03-12

- Added `backend/internal/storage/path.go` and switched file, stream, subtitle, translation, whisper, and admin delete paths to validated `ResolveWithinBase(...)` resolution.
- Fixed subtitle conversion so generated, external, and embedded subtitles resolve from their real storage locations instead of `subtitlePath/<videoPath>`.
- Changed translation engine resolution to read API keys from DB at job runtime, so Settings updates take effect without restarting the backend.
- Hardened Gemini translation failure handling so non-safety provider errors fail the job instead of silently shipping untranslated text.
- Reduced Whisper transcription memory pressure by streaming multipart uploads from Go and adding WAV chunked inference in `whisper/server.py`.
- Relaxed Whisper overlap/hallucination filtering to avoid dropping legitimate short lines and overlap-boundary cues.
- Improved player stability by guarding async session ID startup with a generation ref and adding hls.js fatal error recovery before surfacing playback failure.
- Replaced `os.Exit(0)` shutdown handling with `server.Shutdown(...)`.
- Verified with `GOCACHE=/tmp/ftml-go-build go test ./...`, `npm run build`, and `python3 -m py_compile whisper/server.py`.
- Stage 1 optimization pass: added search debounce/cancellation on the frontend, enforced a minimum search query length, switched backend search to `filepath.WalkDir`, and avoided unnecessary `entry.Info()` calls for directories.
- Added SQLite indexes for hot admin/job/watch-history queries and removed unused `BuildTree(...)` plus the dead `HLSSession.VideoPath` field.
- Verified stage 1 with `GOCACHE=/tmp/ftml-go-build go test ./...` and `npm run build`.
