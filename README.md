# FTML — Folder Tree Media Library

A self-hosted media server that browses your folder structure as-is, streams video with real-time transcoding, and provides AI-powered subtitle generation and translation.

Unlike Jellyfin or Plex, FTML doesn't scrape metadata or reorganize your files. Your folders are your library.

## Features

### Streaming & Playback
- **HLS transcoding** — Real-time transcoding with hardware acceleration (Intel VAAPI, NVIDIA NVENC) and automatic CPU fallback
- **Codec negotiation** — H.264, HEVC, AV1, VP9; server and browser negotiate the best option
- **Passthrough** — Skip transcoding when the browser can play the source codec directly
- **Dynamic quality presets** — Auto-generated based on source resolution (720p → 4K + passthrough + original)
- **Multi-audio** — Switch between audio tracks (e.g. Japanese, English, commentary)
- **Subtitle overlay** — Embedded, external, and AI-generated subtitles with style customization
- **Resume playback** — Automatically saves and restores playback position
- **Next episode** — Auto-advances to the next file in the folder with countdown
- **Keyboard shortcuts** — Full keyboard control (seek, volume, fullscreen, speed, subtitle toggle)
- **Playback stats** — Codec, bitrate, FPS, resolution, network overlay

### AI Subtitles
- **Whisper transcription** — Generate subtitles from audio using OpenVINO GenAI WhisperPipeline
  - Silero VAD for speech detection
  - 4 preprocessing modes: adaptive (BGM-aware), vocal separation, raw, none
  - Runtime model swapping via web UI
  - Automatic VRAM release after idle timeout
- **LLM translation** — Translate subtitles using Gemini, OpenAI, or DeepL
  - Custom translation presets (prompt templates for tone/style)
  - Batch processing (50-cue chunks)
  - Gemini safety-block recovery via binary subdivision retry
- **Batch operations** — Generate/translate subtitles for entire folders at once
- **Format conversion** — SRT ↔ VTT ↔ ASS

### File Management
- **Folder tree** — Browse your actual directory structure, grid or list view
- **File info** — Codec, resolution, audio tracks, file size via ffprobe
- **Thumbnails** — Auto-generated video thumbnails
- **Search** — Filename search across the library
- **Upload / Delete / Move** — Admin file management with trash bin and restore

### Administration
- **User management** — Admin/User roles, registration approval system
- **Session monitoring** — Active HLS sessions with codec, quality, heartbeat info
- **File logs** — Upload/delete/move audit trail
- **Settings GUI** — API keys, Gemini model selection, Whisper model management
- **Jobs dashboard** — Active jobs with progress/ETA, completed/failed history
- **Translation presets** — CRUD for custom translation prompts
- **Rate limiting** — Login/register brute-force protection

## Quick Start

### Prerequisites

- Docker & Docker Compose
- A media folder with video files
- (Optional) Intel Arc GPU for hardware-accelerated transcoding and Whisper inference

### 1. Clone

```bash
git clone https://github.com/NR2BJ/FTML.git
cd FTML
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password    # Change this!
JWT_SECRET=your-random-secret-key      # Change this!
MEDIA_PATH=/path/to/your/videos
FTML_PORT=7979
```

### 3. Create Docker resources

```bash
docker volume create ftml_data
docker volume create whisper_models
```

### 4. Build & Run

```bash
docker compose up -d --build
```

For **NVIDIA GPU** users, add the override file:

```bash
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d --build
```

### 5. Access

Open `http://localhost:7979` and log in with your admin credentials.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USERNAME` | `admin` | Initial admin account |
| `ADMIN_PASSWORD` | `changeme` | Initial admin password (**change this**) |
| `JWT_SECRET` | *(random)* | JWT signing key; set for persistent sessions across restarts |
| `MEDIA_PATH` | `/mnt/storage/video` | Path to your media folder |
| `FTML_PORT` | `7979` | External access port |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |
| `WHISPER_DEVICE` | `GPU` | Whisper inference device (`GPU` or `CPU`) |
| `RENDER_GID` | `109` | GPU render group ID (check `getent group render`) |

### API Keys (Settings page)

Configure these in the web UI under **Settings** after login:

- **Gemini API Key** — For Gemini translation engine
- **OpenAI API Key** — For OpenAI translation engine
- **DeepL API Key** — For DeepL translation engine

### Reverse Proxy

**Caddy** (automatic HTTPS):

```
ftml.yourdomain.com {
    reverse_proxy localhost:7979
}
```

**Nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name ftml.yourdomain.com;

    location / {
        proxy_pass http://localhost:7979;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Tech Stack

| Layer | Stack |
|-------|-------|
| Backend | Go + chi router + SQLite (WAL mode) |
| Frontend | React 18 + TypeScript + Vite + Zustand + Tailwind CSS |
| Media | FFmpeg (VAAPI / NVENC / SW), ffprobe |
| Subtitles | OpenVINO GenAI WhisperPipeline (FastAPI) |
| Translation | Gemini / OpenAI / DeepL |
| Player | hls.js + Media Source Extensions |
| Deploy | Docker Compose (3 containers) |

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Docker Compose                     │
│                                                      │
│  ┌──────────────┐       ┌──────────────┐             │
│  │   Frontend   │       │   Backend    │             │
│  │ React + Nginx│──────▶│   Go :8080   │             │
│  │   :7979      │       │              │             │
│  └──────────────┘       └──────┬───────┘             │
│                                │                     │
│         ┌──────────────────────┼──────────────┐      │
│         ▼                      ▼               ▼     │
│  ┌────────────┐        ┌──────────┐     ┌──────────┐ │
│  │  FFmpeg    │        │  SQLite  │     │  Whisper  ││
│  │  HW Accel  │        │   (DB)   │     │ OpenVINO  ││
│  └─────┬──────┘        └──────────┘     │  :8178    ││
│        ▼                                └─────┬────┘ │
│  ┌───────────┐                          ┌─────┴────┐ │
│  │  /media   │                          │ External  ││
│  │ (volume)  │                          │   APIs    ││
│  └───────────┘                          └──────────┘ │
└──────────────────────────────────────────────────────┘
```

### Transcoding Fallback Chain

```
VAAPI (full GPU decode + encode)
  ↓ fails within 5s
Hybrid (CPU decode + GPU encode)
  ↓ fails within 5s
Software (libx264 / libx265 / libsvtav1)
```

Fallback results are cached per session — subsequent session recreation skips directly to the working encoder.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| ← / → | Seek ±5s |
| J / L | Seek ±10s |
| ↑ / ↓ | Volume |
| M | Mute toggle |
| F | Fullscreen toggle |
| C | Subtitle toggle |
| < / > | Playback speed |
| 0–9 | Jump to 0%–90% |
| I | Playback stats overlay |

## License

MIT
