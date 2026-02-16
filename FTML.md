# FTML — Folder Tree Media Library

폴더 구조 그대로 영상을 탐색하고, 브라우저에서 실시간 트랜스코딩으로 재생하며, AI 자막 생성/번역까지 제공하는 개인 미디어 서버.

## 핵심 철학

- **메타데이터 의존 없음** — Jellyfin/Plex와 달리 폴더 구조 그대로 탐색
- **브라우저 직접 재생** — 실시간 트랜스코딩 + 패스스루
- **자막 생성/번역** — Whisper STT + LLM 번역 (Gemini, OpenAI, DeepL)
- **범용 하드웨어** — Intel Arc (VAAPI), NVIDIA (NVENC), CPU 자동 폴백
- **Docker 원클릭 배포** — Docker Compose로 frontend + backend + whisper

---

## 기술 스택

| 영역 | 스택 |
|------|------|
| 백엔드 | Go + chi router + SQLite (WAL) |
| 프론트엔드 | React 18 + TypeScript + Vite + Zustand + Tailwind CSS |
| 미디어 처리 | FFmpeg (VAAPI/NVENC/SW), ffprobe |
| 자막 생성 | OpenVINO GenAI WhisperPipeline (FastAPI, Python) |
| 자막 번역 | Gemini / OpenAI / DeepL API |
| 비디오 재생 | hls.js + MSE |
| 배포 | Docker Compose (3 컨테이너) |

---

## 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                   Docker Compose                     │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────┐      ┌──────────────┐             │
│  │   Frontend   │      │   Backend    │             │
│  │ React + Nginx│─────▶│   Go :8080   │             │
│  │   :7979      │      │              │             │
│  └──────────────┘      └──────┬───────┘             │
│                               │                      │
│         ┌─────────────────────┼──────────────┐      │
│         ▼                     ▼              ▼      │
│  ┌────────────┐       ┌──────────┐    ┌──────────┐ │
│  │  FFmpeg    │       │  SQLite  │    │  Whisper  │ │
│  │  HW 가속   │       │   (DB)   │    │ OpenVINO  │ │
│  └─────┬──────┘       └──────────┘    │ :8178     │ │
│        ▼                              └─────┬────┘  │
│  ┌───────────┐                        ┌─────┴────┐  │
│  │ /media    │                        │ 외부 API  │  │
│  │ (볼륨)    │                        │ Gemini   │  │
│  └───────────┘                        │ OpenAI   │  │
│                                       │ DeepL    │  │
│                                       └──────────┘  │
└─────────────────────────────────────────────────────┘
```

### 데이터 흐름

**HLS 재생 (트랜스코딩/패스스루)**:
```
브라우저 → GET /api/stream/hls/{path}?quality=1080p&codec=av1
→ 백엔드: ffprobe 정보 확인 → 프리셋 생성 → FFmpeg 실시간 인코딩
→ fMP4 세그먼트(init.mp4 + seg_*.m4s) → m3u8 재작성 → 브라우저(hls.js)
```

**자막 생성**:
```
POST /api/subtitle/generate/{path}
→ Job Queue 등록 → Whisper 서버(VAD + 전처리 → WhisperPipeline)
→ SRT 생성 → DB 상태 업데이트 → 프론트 폴링으로 진행률 확인
```

**자막 번역**:
```
POST /api/subtitle/translate/{path}
→ Job Queue → SRT 파싱 → 배치 분할(50큐)
→ LLM API (프리셋 프롬프트 적용) → 번역된 SRT 저장
```

---

## 구현된 기능

### 1. 인증 & 권한

- **JWT 인증** — 로그인 시 토큰 발급, 24시간 만료
- **역할 2종** — `admin` (전체 권한) / `user` (재생 + 자막 생성/번역)
- **회원가입 승인제** — 가입 신청 → 관리자 승인/거절
- **Rate Limiting** — 로그인/가입 5회/분 제한

### 2. 파일 탐색 & 관리

- **폴더 트리** — 실제 파일시스템 구조 그대로 탐색, 그리드/리스트 뷰 전환
- **파일 정보** — ffprobe 기반 코덱, 해상도, 오디오 트랙 등
- **썸네일** — FFmpeg으로 자동 생성
- **검색** — 파일명 텍스트 검색
- **코덱/해상도 뱃지** — 4K/1080p/720p, HEVC/AV1/VP9, HDR 자동 표시
- **파일 관리** (Admin) — 업로드, 삭제, 이동, 폴더 생성
- **휴지통** — 삭제 시 휴지통 이동 → 복원/영구삭제

### 3. 비디오 플레이어

- **HLS 스트리밍** — hls.js + fMP4 세그먼트
- **패스스루** — 브라우저 호환 코덱이면 트랜스코딩 스킵 (video copy + audio AAC)
- **화질 선택** — 동적 프리셋 (원본 해상도 기반 720p~4K + 패스스루 + 원본)
- **코덱 선택** — 서버/브라우저 코덱 협상 (H.264, HEVC, AV1, VP9)
- **멀티 오디오** — 오디오 트랙 선택 (일본어/영어/코멘터리 등)
- **자막** — 내장/외부/생성된 자막 선택, 스타일 설정 (크기, 위치, 불투명도)
- **이어보기** — 재생 위치 자동 저장/복원
- **키보드 단축키** — Space(재생), ←→(5초), JL(10초), ↑↓(볼륨), M(음소거), F(전체화면), C(자막)
- **재생 통계** — 코덱, 비트레이트, FPS, 해상도, 네트워크 상태 오버레이
- **다음 에피소드** — 같은 폴더 내 다음 파일 자동 전환 + 카운트다운
- **재생 속도** — 0.5x ~ 2.0x
- **A-B 구간 반복** — 시작/끝 지점 설정, 프로그레스 바 마커 표시
- **PiP (Picture-in-Picture)** — 브라우저 PiP 모드
- **스크린샷 캡처** — 현재 프레임 PNG 다운로드
- **챕터** — MKV 내장 챕터 읽기, 챕터 목록에서 점프
- **모바일 제스처** — 수평 스와이프(시크), 수직 스와이프(볼륨), 피드백 오버레이

### 4. 트랜스코딩

- **하드웨어 가속** — Intel Arc VAAPI, NVIDIA NVENC, CPU 소프트웨어
- **3단계 폴백** — VAAPI(full GPU) → Hybrid(CPU decode + GPU encode) → Software
- **폴백 캐시** — 한번 폴백한 세션은 재생성 시 바로 캐시된 인코더 사용
- **코덱 지원** — H.264, HEVC, AV1, VP9 (인코더별)
- **동적 프리셋** — 원본 해상도/비트레이트 기반으로 화질 옵션 자동 생성
- **세션 관리** — 하트비트(15초), SIGSTOP/SIGCONT 일시정지, 유휴 타임아웃(45초/5분)
- **fMP4 출력** — 패스스루/트랜스코딩 모두 fMP4 사용, 코덱 태그(avc1/hvc1) 자동 설정

### 5. 자막 시스템

- **Whisper 자막 생성** — OpenVINO GenAI WhisperPipeline
  - VAD(Silero) 기반 음성 구간 감지
  - 전처리 4모드: adaptive(기본), vocal_sep(보컬분리), raw, none
  - VRAM 자동 해제 (120초 유휴 시) + 다음 요청 시 자동 재로드
  - 런타임 모델 스왑 (웹 UI에서 모델 변경)
- **자막 번역** — Gemini, OpenAI, DeepL
  - 번역 프리셋 (커스텀 프롬프트 저장)
  - 배치 처리 (50큐 단위)
  - Gemini 차단 시 이진 분할 재시도
- **듀얼 자막** — 원문 + 번역 동시 표시 (Primary/Secondary 독립 선택)
- **배치 작업** — 폴더 단위 일괄 생성/번역/생성+번역
- **포맷 변환** — SRT ↔ VTT ↔ ASS
- **삭제 승인** — 일반 사용자가 삭제 요청 → 관리자 승인

### 6. 작업 큐 & 대시보드

- **작업 유형** — `transcribe` (자막 생성), `translate` (자막 번역)
- **독립 워커** — 생성/번역 각각 별도 goroutine 워커
- **진행률 추적** — 폴링 기반 (활성 3초/유휴 30초 적응형)
- **취소/재시도** — 실행 중 작업 취소, 실패 작업 재시도
- **Jobs 페이지** — 요약 카드 + 활성 작업 상세(ETA, 파라미터) + 최근 완료/실패 목록

### 7. 관리자 기능

- **사용자 관리** — CRUD, 역할 변경
- **회원가입 승인** — 승인/거절 + 대기 수 뱃지
- **자막 삭제 승인** — 사용자 요청 승인/거절
- **세션 모니터링** — 활성 HLS 세션 목록 (입력, 화질, 코덱, 마지막 하트비트)
- **파일 로그** — 업로드/삭제/이동 이력 (사용자, 시간, 경로)
- **대시보드** — 업타임, 총 사용자, 스토리지, 활성 작업, 최근 로그
- **설정 GUI** — API 키 (Gemini/OpenAI/DeepL), Gemini 모델 선택
- **Whisper 관리** — 모델 다운로드/활성화, 백엔드 추가/삭제/헬스체크
- **번역 프리셋** — 커스텀 프롬프트 CRUD
- **Rate Limit** — 상태 확인, IP별/전체 초기화
- **휴지통** — 복원, 영구 삭제

### 8. 사용자 기능

- **시청 기록** — 시청한 영상 목록 + 진행률 바 + 이어보기
- **이어보기** — 재생 위치 자동 저장
- **비밀번호 변경**

---

## 구현 상세

### HLS & fMP4

- 패스스루/트랜스코딩 모두 fMP4 세그먼트 사용 (mpegts는 MKV 리먹싱 시 DTS 문제)
- H.264는 `-tag:v avc1`, HEVC는 `-tag:v hvc1` 필수 (MSE 파싱용)
- MKV→fMP4: `-avoid_negative_ts make_zero -fflags +genpts+igndts -max_interleave_delta 0`
- 패스스루 A/V 싱크: video PTS 리셋(`setts`) + audio PTS 보정(`aresample=async=1`)

### VAAPI 폴백 체인

```
VAAPI (full GPU decode+encode)
  ↓ 5초 내 실패
Hybrid (CPU decode + GPU encode, hwupload 필터)
  ↓ 5초 내 실패
Software (libx264/libx265/libsvtav1)
```
폴백 결과는 세션 캐시에 저장 → 세션 재생성 시 바로 캐시된 인코더 사용

### Whisper 서버

- OpenVINO GenAI의 WhisperPipeline 래핑 (FastAPI)
- Silero VAD로 음성 구간 감지 → 무음/BGM 구간 필터링
- 전처리 모드:
  - `adaptive` — BGM 감지 + 경량 필터 + VAD (기본)
  - `vocal_sep` — MDX-Net ONNX 보컬 분리 (CPU)
  - `raw` — 전처리 없음
  - `none` — VAD만 적용
- VRAM 자동 해제: 120초 유휴 시 모델 언로드, 다음 요청 시 자동 로드
- 모델 스왑: 이전 모델 언로드 → 새 모델 로드 (VRAM OOM 방지)
- `task="transcribe"` 강제 설정 (whisper-v3 기본값 translate 버그 우회)

### 번역 파이프라인

- SRT 파싱 → 50큐 배치 → LLM API → 번역 결과 조합
- Gemini 차단 시: 이진 분할 재시도 (반으로 쪼개서 재요청, 재귀)
- 번역 프리셋: 커스텀 프롬프트로 어투/스타일 제어

---

## API 엔드포인트

### 공개

```
GET  /api/health                              # 헬스체크
POST /api/auth/login                          # 로그인
POST /api/auth/register                       # 회원가입 (승인 대기)
```

### 인증 필요 (모든 사용자)

```
GET  /api/auth/me                             # 현재 사용자 정보

# 파일
GET  /api/files/tree/*                        # 폴더 트리
GET  /api/files/info/*                        # 파일 정보
GET  /api/files/thumbnail/*                   # 썸네일
GET  /api/files/search                        # 검색
POST /api/files/batch-info                    # 배치 정보
GET  /api/files/siblings/*                    # 같은 폴더 파일

# 스트리밍
GET  /api/stream/capabilities                 # 코덱 협상
GET  /api/stream/presets/*                    # 화질 프리셋
GET  /api/stream/hls/*                        # HLS 재생
GET  /api/stream/direct/*                     # 직접 재생
POST /api/stream/heartbeat/{id}              # 하트비트
POST /api/stream/pause/{id}                  # 일시정지
POST /api/stream/resume/{id}                 # 재개
DELETE /api/stream/session/{id}              # 세션 종료

# 자막 (읽기)
GET  /api/subtitle/list/*                     # 자막 목록
GET  /api/subtitle/content/*                  # 자막 내용 (WebVTT)

# 작업 (읽기)
GET  /api/jobs                                # 작업 목록
GET  /api/jobs/active                         # 활성 작업
GET  /api/jobs/{id}                           # 작업 상세

# 사용자
GET  /api/user/history                        # 시청 기록 목록
PUT  /api/user/history/*                      # 재생 위치 저장
GET  /api/user/history/*                      # 재생 위치 조회
DELETE /api/user/history/*                    # 기록 삭제
PUT  /api/user/password                       # 비밀번호 변경

# Whisper 백엔드 (읽기)
GET  /api/whisper/backends/available          # 사용 가능한 백엔드
```

### user 이상 (자막 작업)

```
POST /api/subtitle/generate/*                 # 자막 생성
POST /api/subtitle/translate/*                # 자막 번역
POST /api/subtitle/upload/*                   # 자막 업로드
POST /api/subtitle/batch-generate             # 배치 생성
POST /api/subtitle/batch-translate            # 배치 번역
POST /api/subtitle/batch-generate-translate   # 배치 생성+번역
POST /api/subtitle/convert/*                  # 포맷 변환
POST /api/subtitle/delete-request/*           # 삭제 요청
GET  /api/subtitle/my-delete-requests         # 내 삭제 요청
DELETE /api/jobs/{id}                         # 작업 취소
POST /api/jobs/{id}/retry                     # 작업 재시도
```

### admin 전용

```
# 자막
DELETE /api/subtitle/delete/*

# 설정
GET/PUT /api/settings

# Whisper 모델
GET  /api/whisper/models
POST /api/whisper/models/active
GET  /api/gpu/info

# 번역 프리셋
GET/POST /api/presets
PUT/DELETE /api/presets/{id}

# Gemini 모델
GET  /api/gemini/models

# Whisper 백엔드
GET/POST /api/whisper/backends
PUT/DELETE /api/whisper/backends/{id}
POST /api/whisper/backends/{id}/health

# 사용자 관리
GET/POST /api/admin/users
PUT/DELETE /api/admin/users/{id}
GET  /api/admin/users/{id}/history

# 회원가입 승인
GET  /api/admin/registrations[/count]
POST /api/admin/registrations/{id}/approve|reject
DELETE /api/admin/registrations/{id}

# 삭제 요청 승인
GET  /api/admin/delete-requests[/count]
POST /api/admin/delete-requests/{id}/approve|reject
DELETE /api/admin/delete-requests/{id}

# 파일 관리
POST /api/files/upload/*, DELETE /api/files/delete/*
PUT /api/files/move, POST /api/files/mkdir/*

# 휴지통
GET /api/files/trash, POST /api/files/trash/restore
DELETE /api/files/trash/empty|{name}

# 모니터링
GET  /api/admin/sessions|dashboard|file-logs

# Rate Limit
GET/DELETE /api/admin/ratelimit[/{ip}]
```

---

## 프로젝트 구조

```
FTML/
├── docker-compose.yml
├── docker-compose.nvidia.yml
├── .env.example
├── Caddyfile.example
│
├── backend/
│   ├── Dockerfile, main.go
│   └── internal/
│       ├── api/
│       │   ├── router.go
│       │   ├── handlers/    # auth, files, stream, subtitle, job, user, admin,
│       │   │                # settings, presets, whisper_models, whisper_backends, gemini_models
│       │   └── middleware/  # auth, cors, logging, ratelimit, bodylimit
│       ├── auth/            # jwt.go, password.go
│       ├── config/          # config.go
│       ├── db/              # sqlite.go
│       ├── ffmpeg/          # hls.go, probe.go, preset.go, hwaccel.go, thumbnail.go
│       ├── gpu/             # detect.go
│       ├── job/             # queue.go, types.go
│       ├── storage/         # filesystem.go, search.go
│       └── subtitle/
│           ├── whisper/     # service, openvino_genai, openai, interface
│           └── translate/   # service, gemini, openai, deepl, presets, vtt
│
├── frontend/
│   ├── Dockerfile, nginx.conf
│   └── src/
│       ├── App.tsx
│       ├── api/             # client, auth, files, stream, subtitle, job, user, admin, settings, ...
│       ├── stores/          # auth, player, browse, job, subtitleSettings, theme, toast, layout
│       ├── utils/           # format, codec, session
│       ├── components/
│       │   ├── Player/      # Player, Controls, QualitySelector, AudioSelector,
│       │   │                # SubtitleDisplay/Selector/Generate/Translate/Settings,
│       │   │                # PlaybackStats, NextEpisodeOverlay, ChapterList
│       │   ├── Browse/      # BatchSubtitleDialog, ContextMenu, DetailsView, SubtitleManagerDialog
│       │   ├── layout/      # Header, Sidebar, Layout, JobIndicator
│       │   └── WhisperModelManager, WhisperBackendManager, Toast
│       └── pages/
│           ├── Login, Browse, Watch, WatchHistory, Account, Jobs, Settings
│           └── admin/       # Dashboard, UserManagement, Registrations, DeleteRequests,
│                            # Sessions, Trash, RateLimits
│
└── whisper/
    ├── Dockerfile.openvino-genai
    ├── server.py
    ├── vocal_separator.py
    └── requirements.txt
```

---

## 배포 & 설정

### Docker Compose

3개 컨테이너: `frontend` (Nginx :7979), `backend` (Go :8080), `whisper` (FastAPI :8178)

볼륨:
- `ftml_data` — SQLite DB, 생성된 자막, 작업 상태
- `whisper_models` — HuggingFace 모델 캐시
- `${MEDIA_PATH}` — 미디어 폴더 (기본 `/mnt/storage/video`)

### 환경 변수 (.env)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `ADMIN_USERNAME` | `admin` | 초기 관리자 계정 |
| `ADMIN_PASSWORD` | `changeme` | 초기 관리자 비밀번호 (반드시 변경) |
| `JWT_SECRET` | (빈값→랜덤생성) | JWT 서명 키 |
| `MEDIA_PATH` | `/mnt/storage/video` | 미디어 폴더 경로 |
| `FTML_PORT` | `7979` | 외부 접속 포트 |
| `CORS_ORIGINS` | `*` | 허용 오리진 |
| `WHISPER_DEVICE` | `GPU` | Whisper 디바이스 (GPU/CPU) |
| `RENDER_GID` | `109` | GPU 렌더 그룹 ID |

### DB 설정 (Settings 테이블, 웹 UI에서 관리)

| 키 | 설명 |
|----|------|
| `gemini_api_key` | Gemini API 키 |
| `openai_api_key` | OpenAI API 키 |
| `deepl_api_key` | DeepL API 키 |
| `gemini_model` | 사용할 Gemini 모델 (기본: gemini-2.0-flash) |

### 리버스 프록시

**Caddy**:
```
video.example.com {
    reverse_proxy localhost:7979
}
```

**Nginx**:
```nginx
server {
    listen 443 ssl http2;
    server_name video.example.com;

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

---

## TODO

### 핵심 미구현

- [ ] 폴더별 접근 권한 — 특정 폴더를 특정 사용자/역할에 제한
- [ ] 다국어 (i18n) — 한국어/영어 UI (디렉토리 구조만 존재, 미구현)
- [ ] PostgreSQL 옵션 — 대규모 환경용 (현재 SQLite 전용)
- [ ] 초대 링크 — 링크 기반 가입 (현재는 관리자 승인만)
- [ ] QSV / AMF 지원 — Intel QSV, AMD AMF 인코딩 최적화
- [ ] NVIDIA NVENC — NVENC 인코더 통합 (docker-compose.nvidia.yml만 존재, 인코더 미구현)

### 트랜스코딩

- [ ] VAAPI 10bit 하이브리드 모드 — CPU decode + VAAPI encode로 10bit 소스 처리
- [ ] Opus 오디오 코덱 — AAC 외 Opus 지원 (fmp4 전용)
- [ ] 커스텀 인코딩 설정 UI — CRF, 비트레이트, 오디오 코덱 직접 지정

### 플레이어

- [ ] 오프닝/엔딩 스킵 — 수동 마킹 기반
- [ ] 북마크/타임스탬프 메모
- [ ] 외부 플레이어 연동 — mpv:// 프로토콜
- [ ] 호버 프리뷰 — 썸네일 스냅샷 슬라이드
- [ ] 프로그레스 바 프리뷰 — 시크 바 위 썸네일

### 파일 탐색

- [ ] 스마트 폴더/가상 컬렉션 — 즐겨찾기, 나중에 보기
- [ ] 시리즈 자동 감지 — S01E01 패턴 그룹핑
- [ ] 중복 파일 탐지
- [ ] 폴더별 메타데이터 메모
- [ ] 폴더 용량 표시
- [ ] 신규 파일 표시 — NEW 뱃지
- [ ] 파일 시스템 감시 — inotify 기반 자동 인덱싱
- [ ] 필터링 — 파일 타입, 코덱, 해상도, 크기
- [ ] 퍼지 검색 — 오타 허용

### 자막

- [ ] 자막 에디터 — 타임라인 기반 텍스트/타이밍 수정
- [ ] 자막 검색 — 텍스트 검색 → 타임스탬프 점프
- [ ] 자막 임포트 — OpenSubtitles 등 외부 검색/다운로드
- [ ] 번역 메모리 — 이전 번역 용어 재사용
- [ ] 번역 품질 피드백 — 수정/피드백 → 프롬프트 개선

### UX & 디자인

- [ ] 영상 카드 UI — 시청 진행률 바 표시 (썸네일+뱃지는 구현됨)
- [ ] URL 딥링크 — `/watch/path?t=1234`
- [ ] QR 코드 공유 — 모바일 이어보기
- [ ] 로딩 스켈레톤
- [ ] GPU 사용률 그래프 — 시간대별 추이
- [ ] 스토리지 시각화 — 폴더별 트리맵
- [ ] 접근성 — ARIA 레이블, 포커스 링

### 성능 & 안정성

- [ ] 적응형 비트레이트 (ABR) — 네트워크 상태 기반 자동 화질
- [ ] 트랜스코딩 세션 풀링 — 동일 파일 다중 사용자 세션 공유
- [ ] 캐시 관리 — 세그먼트 캐싱 + 자동 정리
- [ ] 프리페치 — 다음 에피소드 세그먼트 미리 로드
- [ ] Graceful shutdown — 활성 세션/FFmpeg 프로세스 정리 (시그널 핸들링만 존재)

### 관리 & 운영

- [ ] 웹훅/알림 — Discord/Telegram 알림
- [ ] 스케줄링 — 야간 배치 실행
- [ ] 백업/복원 — DB + 설정 + 자막
- [ ] 감사 로그 — 전체 액션 이력 기록 (파일 로그만 존재)
- [ ] LDAP/SSO 연동
- [ ] 다중 미디어 폴더 — 여러 경로 마운트
- [ ] 업데이트 알림 — 새 버전 대시보드 알림
- [ ] 스토리지 알림 — 디스크 용량 임계치 경고

### 추가 미디어 지원

- [ ] 이미지 뷰어 — 갤러리 모드 (만화/아트북)
- [ ] 오디오 플레이어 — 음악 재생 + 앨범아트
- [ ] RSS/팟캐스트 피드 — 폴더를 팟캐스트로 노출

### 테스트 필요

- [ ] OpenAI Whisper API — 구현 완료 (`openai.go`), 실환경 테스트 필요
- [ ] faster-whisper CUDA — 미구현 (OpenVINO GenAI만 존재), NVIDIA GPU용 백엔드 추가 필요
- [ ] DeepL 번역 — 구현 완료 (`deepl.go`), 번역 품질 테스트 필요
- [ ] AMD ROCm/VAAPI — GPU 감지 구현됨, AMD 전용 환경 테스트 필요

---

## 키보드 단축키

| 키 | 기능 |
|----|------|
| Space | 재생/일시정지 |
| ← / → | 5초 뒤로/앞으로 |
| J / L | 10초 뒤로/앞으로 |
| ↑ / ↓ | 볼륨 조절 |
| M | 음소거 토글 |
| F | 전체화면 토글 |
| C | 자막 토글 |
| < / > | 재생 속도 |
| B | A-B 구간 반복 설정 |
| P | PiP 토글 |
| S | 스크린샷 캡처 |
| 0-9 | 0%~90% 위치 |
| I | 재생 통계 토글 |
