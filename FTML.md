# Video Stream Project - 전체 명세서

## 프로젝트 개요

### 목적
Debian 서버에서 특정 디렉토리(/mnt/storage/video)를 웹 브라우저에서 폴더 트리 형태로 탐색하고, 브라우저에서 바로 재생할 수 있는 미디어 서버.

### 핵심 철학
- **메타데이터 의존 없음**: Jellyfin 같은 서비스는 메타데이터 정리가 안 되면 파일을 제대로 볼 수 없음. 이 프로젝트는 폴더 구조 그대로 탐색.
- **폴더 트리 기반**: 영상 파일, 북 스캔, OST 등 모든 파일을 폴더 구조대로 확인 가능
- **브라우저 직접 재생**: 실시간 트랜스코딩으로 브라우저 호환 포맷 변환
- **자막 생성/번역**: Whisper로 자막 생성, 다양한 API로 번역
- **범용 하드웨어 지원**: Intel Arc, NVIDIA, AMD, CPU 모두 지원
- **오픈소스 공개**: Docker 이미지로 배포, GitHub 공개

### 배포 형태
- Docker Compose로 원클릭 배포
- 도메인 연결해서 다중 사용자 지원
- Caddy/Nginx 리버스 프록시 지원

---

## 기능 명세

### 1. 인증 & 권한

| 기능 | 상세 |
|------|------|
| 로그인/로그아웃 | JWT 기반 |
| 회원가입 | 관리자 승인 또는 초대 링크 |
| 역할 | Viewer / Editor / Admin |
| 폴더별 권한 | 특정 폴더 접근 제한 가능 |
| 권한 관리 | Admin이 웹 GUI에서 설정 |

**역할별 권한**:
- **Viewer**: 파일 탐색, 재생, 자막 선택
- **Editor**: Viewer + 자막 생성, 자막 번역, 자막 업로드
- **Admin**: Editor + 파일 관리, 사용자 관리, 시스템 설정

### 2. 파일 탐색 & 관리

| 기능 | 권한 |
|------|------|
| 폴더 트리 조회 | All (권한 범위 내) |
| 파일 정보 (크기, 코덱, 해상도 등) | All |
| 썸네일 미리보기 | All |
| 파일명 검색 | All |
| 파일 업로드 | Admin |
| 파일 삭제 | Admin |
| 파일 이동/이름변경 | Admin |

### 3. 비디오 플레이어

**재생 기능**:
- HLS 스트리밍 (실시간 트랜스코딩)
- 원본 직접 재생 (브라우저 호환 포맷일 경우 트랜스코딩 스킵)
- 이어보기 (재생 위치 기억)
- 전체화면
- 키보드 단축키

**화질 설정**:
- 프리셋 모드: 저화질(720p/8Mbps) / 중간(1080p/15Mbps) / 고화질(1080p/25Mbps) / 원본
- 커스텀 모드: 해상도, 프레임레이트, 비트레이트 직접 조절

**자막 설정**:
- 자막 선택 (내장/외부)
- 자막 싱크 조절 (±초)
- 자막 스타일 (크기, 폰트, 색상, 배경)

**오디오 설정**:
- 볼륨 조절
- 재생 속도

**재생 통계 오버레이** (Stats for nerds):
```
Video
  Codec: hevc (원본) → h264 (트랜스코딩)
  Resolution: 1920x1080
  Bitrate: 15.2 Mbps
  Framerate: 23.976 fps

Audio
  Codec: aac
  Bitrate: 320 kbps
  Channels: 5.1
  Sample Rate: 48000 Hz

Network
  Buffer: 12.3s
  Dropped Frames: 0
  Download Speed: 18.4 Mbps

Playback
  Current Time: 00:23:45
  Duration: 01:32:10
```

### 4. 트랜스코딩

**하드웨어 가속 지원**:

| GPU | 기술 | H.264 | H.265 | AV1 |
|-----|------|-------|-------|-----|
| Intel Arc | QSV | ✅ | ✅ | ✅ |
| Intel 내장 | QSV | ✅ | ✅ | ❌ |
| NVIDIA | NVENC | ✅ | ✅ | ✅ (RTX 40+) |
| AMD | VCE/VAAPI | ✅ | ✅ | ✅ (RX 7000+) |
| CPU | libx264 | ✅ | ✅ | ✅ (느림) |

**출력 코덱 옵션**:
- H.264 + AAC (기본, 모든 브라우저 호환)
- H.264 + Opus
- H.265 + AAC (Chrome/Safari만, Firefox 미지원)
- AV1 + Opus (최신 브라우저, 신형 GPU 권장)

**브라우저 코덱 지원 현황**:

| 코덱 | Chrome/Edge | Firefox | Safari |
|------|-------------|---------|--------|
| H.264 | ✅ | ✅ | ✅ |
| H.265 | ⚠️ HW만 | ❌ | ✅ |
| VP9 | ✅ | ✅ | ⚠️ macOS 14+ |
| AV1 | ✅ | ✅ | ✅ Safari 17+ |
| AAC | ✅ | ✅ | ✅ |
| Opus | ✅ | ✅ | ✅ Safari 15+ |

**비트레이트 참고 (1080p)**:
- H.264: 15~20 Mbps 권장 (깍두기 방지)
- H.265: 8~12 Mbps
- AV1: 6~10 Mbps

**설정 항목**:
- GPU 자동 감지 / 수동 선택
- 출력 코덱 선택
- 비트레이트 설정 (프리셋 또는 커스텀)
- Admin GUI에서 설정 가능

### 5. 자막 생성 (Whisper)

**엔진 옵션**:

| 엔진 | NVIDIA (CUDA) | Intel Arc (SYCL) | AMD (ROCm) | CPU |
|------|---------------|------------------|------------|-----|
| whisper.cpp | ✅ | ✅ (SYCL 빌드) | ✅ (CLBlast) | ✅ |
| faster-whisper | ✅ 최고 | ❌ | ⚠️ 제한적 | ✅ |
| OpenAI API | 클라우드 | 클라우드 | 클라우드 | 클라우드 |

**기본 전략**:
- Intel Arc → whisper.cpp (SYCL)
- NVIDIA → faster-whisper (CUDA) 또는 whisper.cpp
- AMD → whisper.cpp (CLBlast)
- CPU만 → whisper.cpp
- GPU 없음/빠른 처리 → OpenAI API

**설정 항목**:
- 엔진 선택 (whisper.cpp / faster-whisper / OpenAI API)
- 모델 선택: tiny, base, small, medium, large-v3 (로컬)
- 언어 설정: 자동 감지 또는 수동
- 출력 형식: SRT / VTT

**권한**: Editor 이상

### 6. 자막 번역

**백엔드 옵션** (플러그인 구조):
- Gemini API
- OpenAI API (GPT-4 등)
- DeepL API
- Ollama (로컬 LLM)
- 기타 확장 가능

**번역 프리셋**:
- 애니메이션: 캐주얼한 어투, 일본어 특유 표현 처리
- 영화: 자연스러운 대화체
- 다큐멘터리: 정확하고 격식있는 어투, 전문용어 유지
- 커스텀: 사용자 정의 프롬프트

**설정 항목**:
- 기본 번역 백엔드 선택
- API 키 관리 (Admin GUI에서)
- 프리셋 관리

**권한**: Editor 이상

### 7. 관리자 대시보드

**작업 관리**:
- 작업 큐 목록 (트랜스코딩, 자막 생성, 번역)
- 실시간 진행률 표시
- 작업 취소/재시도

**시스템 모니터링**:
- CPU 사용률
- GPU 사용률 (인코딩/디코딩)
- 메모리 사용량
- 디스크 사용량

**접속 현황**:
- 현재 접속 유저 목록
- 각 유저가 시청 중인 영상
- 실시간 스트리밍 세션

**설정 GUI**:
- API 키 관리 (Whisper, Gemini, DeepL 등)
- 사용자 관리 (생성, 역할 변경, 삭제)
- 트랜스코딩 설정 (기본 코덱, 비트레이트)
- 폴더 권한 설정

**시청 기록**:
- 유저별 시청 기록 조회

### 8. 사용자 기능

| 기능 | 상세 |
|------|------|
| 본인 시청 기록 | 시청한 영상 목록, 진행률 |
| 플레이어 설정 저장 | 자막 스타일, 기본 화질 등 |
| 프로필 관리 | 비밀번호 변경 |

### 9. 배포 & 시스템

**Docker Compose**:
- 최소 필수 설정만 compose에 (포트, 볼륨 경로)
- 나머지는 Admin GUI에서 설정

**설정 저장**:
- SQLite (기본) 또는 PostgreSQL (대규모)

**리버스 프록시**:
- Caddy 설정 예시 제공
- Nginx 설정 예시 제공
- HTTPS 지원

**다국어**:
- 한국어
- 영어
- i18n 구조로 확장 가능

---

## 기술 스택

### 백엔드

| 항목 | 선택 | 이유 |
|------|------|------|
| 언어 | **Go** | 동시성 처리 우수, 단일 바이너리, 메모리 효율, 가벼운 Docker 이미지 |
| HTTP | net/http + chi 또는 gin | 경량 라우터 |
| DB | SQLite (기본) / PostgreSQL (옵션) | 간단한 배포 |
| 인증 | JWT | 스테이트리스 |
| 작업 큐 | Go 채널 (내장) | 외부 의존성 없음, 단순화 |

### 프론트엔드

| 항목 | 선택 | 이유 |
|------|------|------|
| 프레임워크 | **React 18 + TypeScript** | 생태계, 컴포넌트 풍부 |
| 빌드 | Vite | 빠른 개발 서버 |
| 상태 관리 | Zustand | 가볍고 단순 |
| 스타일 | Tailwind CSS | 빠른 UI 개발 |
| 비디오 | hls.js + 커스텀 컨트롤 | HLS 재생, 완전한 UI 제어 |
| 아이콘 | Lucide React | |
| i18n | react-i18next | 다국어 |

### 미디어 처리

| 항목 | 선택 |
|------|------|
| 트랜스코딩 | FFmpeg (시스템) |
| HW 가속 | QSV / NVENC / VAAPI 자동 감지 |
| 썸네일 | FFmpeg |
| 미디어 정보 | FFprobe |
| HLS 출력 | m3u8 + ts 세그먼트 |

### 자막 처리

| 항목 | 선택 |
|------|------|
| Whisper 로컬 (기본) | whisper.cpp (SYCL/CUDA/CLBlast/CPU) |
| Whisper 로컬 (NVIDIA 최적) | faster-whisper |
| Whisper 클라우드 | OpenAI API |
| 번역 | 플러그인 구조 (Gemini, OpenAI, DeepL, Ollama) |

---

## 아키텍처

### 전체 구조도

```
┌─────────────────────────────────────────────────────────────┐
│                      Docker Compose                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────┐       ┌────────────────┐                │
│  │    Frontend    │       │    Backend     │                │
│  │   (React SPA)  │──────▶│     (Go)       │                │
│  │   Nginx 서빙    │       │                │                │
│  │   Port: 80     │       │   Port: 8080   │                │
│  └────────────────┘       └───────┬────────┘                │
│                                   │                          │
│           ┌───────────────────────┼───────────────────┐     │
│           │                       │                   │     │
│           ▼                       ▼                   ▼     │
│    ┌────────────┐         ┌────────────┐      ┌──────────┐ │
│    │  FFmpeg    │         │  SQLite/   │      │ Whisper  │ │
│    │ (트랜스코딩) │         │ PostgreSQL │      │Container │ │
│    │  HW 가속    │         │   (DB)     │      │ (자막)   │ │
│    └─────┬──────┘         └────────────┘      └────┬─────┘ │
│          │                                         │       │
│          ▼                                         ▼       │
│   ┌─────────────┐                          ┌───────────┐   │
│   │/mnt/storage │                          │ 외부 API   │   │
│   │  /video     │                          │ - OpenAI   │   │
│   │  (볼륨)      │                          │ - Gemini   │   │
│   └─────────────┘                          │ - DeepL    │   │
│                                            └───────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 컨테이너 구성

```yaml
# docker-compose.yml 구조
services:
  frontend:
    # React SPA, Nginx로 서빙
    ports: ["80:80"]
    
  backend:
    # Go API 서버
    ports: ["8080:8080"]
    volumes:
      - /mnt/storage/video:/media:ro  # 미디어 폴더
      - ./data:/data                   # DB, 설정
    
  whisper-sycl:    # Intel Arc용 (선택)
  whisper-cuda:    # NVIDIA용 (선택)
  whisper-cpu:     # CPU fallback
```

### 데이터 흐름

**비디오 재생 (트랜스코딩)**:
```
1. 브라우저 → GET /api/stream/hls/{path}/master.m3u8
2. 백엔드 → FFprobe로 원본 정보 확인
3. 백엔드 → m3u8 매니페스트 생성 (화질 옵션 포함)
4. 브라우저 → hls.js가 세그먼트 요청
5. 백엔드 → FFmpeg 실시간 트랜스코딩 → ts 세그먼트 반환
6. 브라우저 → 재생
```

**비디오 재생 (직접 재생)**:
```
1. 브라우저 → 원본 코덱 확인 (MediaCapabilities API)
2. 호환 시 → GET /api/stream/direct/{path}
3. 백엔드 → Range 요청 지원하며 원본 파일 스트리밍
```

**자막 생성**:
```
1. 사용자 → POST /api/subtitle/generate/{path}
2. 백엔드 → 작업 큐에 추가
3. Whisper 컨테이너 → 오디오 추출 → STT 처리
4. 완료 → SRT/VTT 파일 저장
5. 웹소켓으로 진행률/완료 알림
```

**자막 번역**:
```
1. 사용자 → POST /api/subtitle/translate/{path}
2. 백엔드 → 원본 자막 파싱
3. 선택된 API로 번역 요청 (프리셋 프롬프트 적용)
4. 번역된 자막 저장
5. 완료 알림
```

---

## API 구조

### 인증

```
POST   /api/auth/login          # 로그인 → JWT 발급
POST   /api/auth/register       # 회원가입 (승인 대기)
POST   /api/auth/logout         # 로그아웃
POST   /api/auth/refresh        # 토큰 갱신
GET    /api/auth/me             # 현재 사용자 정보
```

### 파일 시스템

```
GET    /api/files/tree                    # 폴더 트리 (권한 필터링)
GET    /api/files/tree/{path}             # 특정 폴더 하위
GET    /api/files/info/{path}             # 파일 상세 정보 (코덱, 해상도 등)
GET    /api/files/thumbnail/{path}        # 썸네일 이미지
GET    /api/files/search?q={query}        # 파일명 검색

# Admin 전용
POST   /api/files/upload/{path}           # 파일 업로드
DELETE /api/files/{path}                  # 파일/폴더 삭제
PUT    /api/files/move                    # 이동/이름변경
```

### 스트리밍

```
GET    /api/stream/hls/{path}/master.m3u8     # HLS 마스터 플레이리스트
GET    /api/stream/hls/{path}/{quality}.m3u8  # 화질별 플레이리스트
GET    /api/stream/hls/{path}/{segment}.ts    # HLS 세그먼트
GET    /api/stream/direct/{path}              # 직접 재생 (Range 지원)

# 쿼리 파라미터
?codec=h264|h265|av1
?bitrate=8000|15000|25000  # kbps
?resolution=720|1080|original
```

### 자막

```
GET    /api/subtitle/list/{path}          # 자막 목록 (내장 + 외부)
GET    /api/subtitle/content/{path}       # 자막 내용 (VTT 형식)
POST   /api/subtitle/generate/{path}      # Whisper 자막 생성 요청
POST   /api/subtitle/translate/{path}     # 번역 요청
POST   /api/subtitle/upload/{path}        # 자막 파일 업로드
DELETE /api/subtitle/{path}               # 자막 삭제 (Admin)

# 생성/번역 요청 바디
{
  "engine": "whisper.cpp",      // whisper.cpp | faster-whisper | openai
  "model": "large-v3",          // tiny | base | small | medium | large-v3
  "language": "auto",           // auto | ko | en | ja ...
  "translateTo": "ko",          // 번역 대상 언어
  "translateEngine": "gemini",  // gemini | openai | deepl | ollama
  "preset": "anime"             // anime | movie | documentary | custom
}
```

### 사용자

```
GET    /api/user/history                  # 본인 시청 기록
PUT    /api/user/history/{path}           # 재생 위치 저장
GET    /api/user/settings                 # 본인 설정
PUT    /api/user/settings                 # 설정 저장
PUT    /api/user/password                 # 비밀번호 변경
```

### 관리자

```
# 대시보드
GET    /api/admin/dashboard               # 시스템 상태 요약
GET    /api/admin/stats/system            # CPU, GPU, 메모리, 디스크
GET    /api/admin/stats/sessions          # 현재 접속/스트리밍 세션

# 작업 관리
GET    /api/admin/jobs                    # 작업 큐 목록
GET    /api/admin/jobs/{id}               # 작업 상세
DELETE /api/admin/jobs/{id}               # 작업 취소
POST   /api/admin/jobs/{id}/retry         # 작업 재시도

# 사용자 관리
GET    /api/admin/users                   # 사용자 목록
POST   /api/admin/users                   # 사용자 생성
PUT    /api/admin/users/{id}              # 사용자 수정 (역할 등)
DELETE /api/admin/users/{id}              # 사용자 삭제
GET    /api/admin/users/{id}/history      # 특정 사용자 시청 기록

# 설정
GET    /api/admin/settings                # 전체 설정
PUT    /api/admin/settings                # 설정 저장
GET    /api/admin/settings/api-keys       # API 키 목록 (마스킹)
PUT    /api/admin/settings/api-keys       # API 키 설정

# 폴더 권한
GET    /api/admin/permissions             # 폴더 권한 목록
PUT    /api/admin/permissions             # 권한 설정
```

### 웹소켓

```
WS     /api/ws                            # 실시간 알림
  - 작업 진행률
  - 작업 완료/실패
  - 시스템 상태 업데이트
```

---

## 프로젝트 구조

```
video-stream/
├── docker-compose.yml
├── docker-compose.nvidia.yml      # NVIDIA 오버라이드
├── docker-compose.intel.yml       # Intel Arc 오버라이드
├── docker-compose.amd.yml         # AMD 오버라이드
├── .env.example
├── README.md
├── docs/
│   ├── installation.md
│   ├── configuration.md
│   ├── reverse-proxy-caddy.md
│   └── reverse-proxy-nginx.md
│
├── backend/
│   ├── Dockerfile
│   ├── go.mod
│   ├── go.sum
│   ├── main.go
│   └── internal/
│       ├── api/
│       │   ├── router.go
│       │   ├── middleware/
│       │   │   ├── auth.go
│       │   │   ├── cors.go
│       │   │   └── logging.go
│       │   └── handlers/
│       │       ├── auth.go
│       │       ├── files.go
│       │       ├── stream.go
│       │       ├── subtitle.go
│       │       ├── user.go
│       │       └── admin.go
│       │
│       ├── auth/
│       │   ├── jwt.go
│       │   └── password.go
│       │
│       ├── ffmpeg/
│       │   ├── probe.go           # 미디어 정보 조회
│       │   ├── transcode.go       # 트랜스코딩
│       │   ├── hls.go             # HLS 생성
│       │   ├── thumbnail.go       # 썸네일
│       │   └── hwaccel.go         # GPU 감지
│       │
│       ├── storage/
│       │   ├── filesystem.go      # 파일 시스템 작업
│       │   ├── tree.go            # 트리 생성
│       │   └── search.go          # 검색
│       │
│       ├── subtitle/
│       │   ├── parser.go          # SRT/VTT 파싱
│       │   ├── whisper.go         # Whisper 연동
│       │   └── translate/
│       │       ├── interface.go   # 플러그인 인터페이스
│       │       ├── gemini.go
│       │       ├── openai.go
│       │       ├── deepl.go
│       │       └── ollama.go
│       │
│       ├── job/
│       │   ├── queue.go           # 작업 큐
│       │   ├── worker.go          # 워커
│       │   └── types.go           # 작업 타입
│       │
│       ├── db/
│       │   ├── sqlite.go
│       │   ├── postgres.go
│       │   ├── migrations/
│       │   └── models/
│       │       ├── user.go
│       │       ├── session.go
│       │       ├── history.go
│       │       ├── job.go
│       │       └── setting.go
│       │
│       ├── ws/
│       │   └── hub.go             # 웹소켓 허브
│       │
│       └── config/
│           └── config.go
│
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/
│       │   ├── client.ts          # Axios 설정
│       │   ├── auth.ts
│       │   ├── files.ts
│       │   ├── stream.ts
│       │   ├── subtitle.ts
│       │   └── admin.ts
│       │
│       ├── stores/
│       │   ├── authStore.ts
│       │   ├── playerStore.ts
│       │   └── settingsStore.ts
│       │
│       ├── components/
│       │   ├── common/
│       │   │   ├── Button.tsx
│       │   │   ├── Modal.tsx
│       │   │   └── Loading.tsx
│       │   │
│       │   ├── layout/
│       │   │   ├── Header.tsx
│       │   │   ├── Sidebar.tsx
│       │   │   └── Layout.tsx
│       │   │
│       │   ├── FileTree/
│       │   │   ├── FileTree.tsx
│       │   │   ├── TreeNode.tsx
│       │   │   └── FileInfo.tsx
│       │   │
│       │   ├── Player/
│       │   │   ├── Player.tsx
│       │   │   ├── Controls.tsx
│       │   │   ├── ProgressBar.tsx
│       │   │   ├── VolumeControl.tsx
│       │   │   ├── QualitySelector.tsx
│       │   │   ├── SubtitleSelector.tsx
│       │   │   ├── SubtitleDisplay.tsx
│       │   │   ├── SubtitleSettings.tsx
│       │   │   ├── PlaybackStats.tsx
│       │   │   └── Shortcuts.tsx
│       │   │
│       │   └── Admin/
│       │       ├── Dashboard.tsx
│       │       ├── JobQueue.tsx
│       │       ├── UserManagement.tsx
│       │       ├── Settings.tsx
│       │       └── SystemStats.tsx
│       │
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Browse.tsx
│       │   ├── Watch.tsx
│       │   ├── History.tsx
│       │   ├── Settings.tsx
│       │   └── admin/
│       │       ├── Dashboard.tsx
│       │       ├── Users.tsx
│       │       ├── Jobs.tsx
│       │       └── Settings.tsx
│       │
│       ├── hooks/
│       │   ├── useAuth.ts
│       │   ├── usePlayer.ts
│       │   └── useWebSocket.ts
│       │
│       ├── i18n/
│       │   ├── index.ts
│       │   ├── ko.json
│       │   └── en.json
│       │
│       └── utils/
│           ├── format.ts
│           └── codec.ts
│
└── whisper/
    ├── Dockerfile.sycl            # Intel Arc (oneAPI)
    ├── Dockerfile.cuda            # NVIDIA
    ├── Dockerfile.rocm            # AMD
    ├── Dockerfile.cpu             # CPU fallback
    ├── server.py                  # 간단한 HTTP API 래퍼
    └── requirements.txt
```

---

## 개발 로드맵

### Phase 1: 기반 (MVP)
**목표**: 파일 탐색 + 비디오 재생이 되는 최소 동작 버전

| # | 태스크 | 상세 |
|---|--------|------|
| 1 | 프로젝트 셋업 | Go 모듈, React + Vite, Docker Compose 기본 구조 |
| 2 | 파일 시스템 API | 트리 조회, 파일 정보 (FFprobe) |
| 3 | 기본 인증 | JWT 발급/검증, 단일 Admin 계정 (환경변수) |
| 4 | HLS 스트리밍 | FFmpeg 실시간 트랜스코딩, H.264 고정 |
| 5 | 기본 플레이어 | hls.js 통합, 재생/일시정지/시크 |
| 6 | 원본 직접 재생 | 브라우저 호환 시 트랜스코딩 스킵 |
| 7 | 기본 UI | 파일 트리 + 플레이어 레이아웃 |

**결과물**: 로그인 → 폴더 탐색 → 영상 재생 가능

### Phase 2: 플레이어 완성
**목표**: 제대로 된 비디오 플레이어

| # | 태스크 | 상세 |
|---|--------|------|
| 8 | 플레이어 컨트롤 | 볼륨, 재생속도, 전체화면 |
| 9 | 화질 선택 | 프리셋 (720p/1080p/원본) |
| 10 | 자막 기본 | 외부 자막 로드, 표시 |
| 11 | 자막 설정 | 싱크 조절, 크기/폰트/색상 |
| 12 | 재생 통계 | Stats for nerds 오버레이 |
| 13 | 이어보기 | 재생 위치 저장/복원 |
| 14 | 키보드 단축키 | 스페이스, 방향키, F, M 등 |

**결과물**: 완성도 높은 비디오 플레이어

### Phase 3: 트랜스코딩 고도화
**목표**: 다양한 HW 지원 + 화질 옵션

| # | 태스크 | 상세 |
|---|--------|------|
| 15 | GPU 감지 | QSV/NVENC/VAAPI 자동 감지 |
| 16 | HW 인코딩 | GPU별 FFmpeg 파라미터 |
| 17 | 코덱 옵션 | H.264/H.265/AV1 선택 |
| 18 | 비트레이트 설정 | 프리셋 + 커스텀 |
| 19 | 썸네일 생성 | 파일 목록 미리보기 |

**결과물**: 모든 주요 GPU 지원, 화질 커스터마이징

### Phase 4: 자막 시스템
**목표**: 자막 생성 + 번역 완성

| # | 태스크 | 상세 |
|---|--------|------|
| 20 | Whisper 컨테이너 | whisper.cpp Docker (CPU) |
| 21 | Whisper SYCL | Intel Arc 지원 |
| 22 | Whisper CUDA | NVIDIA 지원 (faster-whisper) |
| 23 | OpenAI Whisper | 클라우드 API 연동 |
| 24 | 자막 생성 UI | 모델 선택, 진행률 표시 |
| 25 | 번역 플러그인 구조 | 인터페이스 정의 |
| 26 | Gemini 번역 | 구현 + 프리셋 |
| 27 | OpenAI 번역 | 구현 |
| 28 | DeepL 번역 | 구현 |
| 29 | 번역 UI | 엔진/프리셋 선택, 진행률 |

**결과물**: 완전한 자막 생성/번역 시스템

### Phase 5: 다중 사용자
**목표**: 권한 시스템 + 사용자 관리

| # | 태스크 | 상세 |
|---|--------|------|
| 30 | DB 스키마 | 사용자, 역할, 권한 테이블 |
| 31 | 회원가입 | 승인 대기 방식 |
| 32 | 초대 링크 | 링크로 가입 |
| 33 | 역할 시스템 | Viewer/Editor/Admin 권한 체크 |
| 34 | 폴더 권한 | 특정 폴더 접근 제한 |
| 35 | 사용자별 설정 | 플레이어 설정 저장 |

**결과물**: 다중 사용자 지원, 세밀한 권한 관리

### Phase 6: 관리자 기능
**목표**: 대시보드 + GUI 설정

| # | 태스크 | 상세 |
|---|--------|------|
| 36 | 대시보드 UI | 시스템 상태 요약 |
| 37 | 시스템 모니터링 | CPU/GPU/메모리/디스크 |
| 38 | 작업 큐 UI | 목록, 진행률, 취소 |
| 39 | 접속 현황 | 실시간 세션 표시 |
| 40 | 사용자 관리 UI | CRUD, 역할 변경 |
| 41 | 설정 GUI | API 키, 트랜스코딩 기본값 |
| 42 | 시청 기록 조회 | 관리자용 |

**결과물**: 완전한 관리자 대시보드

### Phase 7: 마무리
**목표**: 배포 준비 + 문서화

| # | 태스크 | 상세 |
|---|--------|------|
| 43 | 검색 기능 | 파일명 검색 |
| 44 | 다국어 (i18n) | 한국어/영어 |
| 45 | Docker 정리 | compose 파일 최적화 |
| 46 | 문서화 | README, 설치 가이드 |
| 47 | 리버스 프록시 가이드 | Caddy/Nginx 예시 |
| 48 | 테스트 | E2E, 통합 테스트 |
| 49 | CI/CD | GitHub Actions |
| 50 | 릴리즈 | v1.0.0 |

**결과물**: 프로덕션 준비 완료, 오픈소스 공개

---

## 설정 예시

### docker-compose.yml (최소 설정)

```yaml
version: '3.8'

services:
  frontend:
    image: video-stream-frontend:latest
    ports:
      - "80:80"
    depends_on:
      - backend

  backend:
    image: video-stream-backend:latest
    ports:
      - "8080:8080"
    volumes:
      - /mnt/storage/video:/media:ro    # 미디어 폴더 (읽기 전용)
      - ./data:/data                     # DB, 설정, 생성된 자막
    environment:
      - ADMIN_USERNAME=admin             # 초기 관리자
      - ADMIN_PASSWORD=changeme          # 초기 비밀번호
      - JWT_SECRET=your-secret-key
    devices:
      - /dev/dri:/dev/dri                # GPU 접근 (Intel/AMD)

  whisper:
    image: video-stream-whisper:cpu
    volumes:
      - ./data/whisper:/models
      - ./data/subtitles:/output
```

### docker-compose.nvidia.yml (NVIDIA 오버라이드)

```yaml
version: '3.8'

services:
  backend:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  whisper:
    image: video-stream-whisper:cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

### Caddy 리버스 프록시

```
video.example.com {
    reverse_proxy /api/* backend:8080
    reverse_proxy /* frontend:80
}
```

### Nginx 리버스 프록시

```nginx
server {
    listen 443 ssl http2;
    server_name video.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /api/ {
        proxy_pass http://backend:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        proxy_pass http://frontend:80;
        proxy_set_header Host $host;
    }
}
```

---

## 키보드 단축키 (플레이어)

| 키 | 기능 |
|----|------|
| Space | 재생/일시정지 |
| ← / → | 5초 뒤로/앞으로 |
| J / L | 10초 뒤로/앞으로 |
| ↑ / ↓ | 볼륨 조절 |
| M | 음소거 토글 |
| F | 전체화면 토글 |
| C | 자막 토글 |
| < / > | 재생 속도 조절 |
| 0-9 | 0%~90% 위치로 이동 |
| I | 재생 통계 토글 |

---

## 향후 확장 가능성 (v2.0+)

- 모바일 앱 (React Native)
- 공유 링크 (비로그인 시청)
- 실시간 채팅/코멘트
- Watch Party (동시 시청)
- 자막 에디터 (타임라인)
- 플레이리스트
- 시리즈/시즌 자동 인식
- 오프라인 다운로드
- Chromecast/AirPlay 지원

---

## 참고 사항

### H.264 깍두기(블록킹) 문제
- H.264는 8x8 블록 기반 코덱이라 복잡한 장면에서 블록이 드러남
- 유튜브가 깍두기 심한 이유: 대역폭 절약을 위해 5~8Mbps만 할당
- **해결**: FHD 기준 20Mbps 이상이면 화려한 장면도 깍두기 거의 없음
- 비트레이트를 사용자가 설정할 수 있게 함

### Whisper 하드웨어 지원
- Intel Arc는 CUDA가 아닌 oneAPI/SYCL 기반
- faster-whisper는 CUDA 전용이라 Intel Arc에서 사용 불가
- whisper.cpp는 SYCL 빌드로 Intel Arc 지원 가능
- 범용 지원을 위해 whisper.cpp 기본 + 옵션으로 faster-whisper/OpenAI API

### 트랜스코딩 vs 직접 재생
- 브라우저가 원본 코덱을 지원하면 트랜스코딩 없이 직접 스트리밍
- 대역폭 절약 + 화질 손실 없음
- MediaCapabilities API로 브라우저 지원 여부 감지

---

## 미뤄진 작업 / TODO

> 개발 과정에서 식별되었으나 현재 Phase에서 구현하지 않은 항목들.
> 우선순위에 따라 향후 Phase에서 구현 예정.

### 트랜스코딩 관련

| # | 항목 | 상세 | 우선순위 |
|---|------|------|----------|
| 1 | VAAPI 10bit 하이브리드 모드 | CPU decode + VAAPI encode로 10bit H.264/HEVC 소스 처리. 현재는 SW fallback으로 우회 중. | 중 |
| 2 | QSV / NVENC / AMF 지원 | VAAPI 외 다른 HW 가속기 10bit 호환성 테스트 및 지원. 멀티 GPU 환경 대응. | 중 |
| 3 | Opus 오디오 코덱 옵션 | AAC 외 Opus 트랜스코딩 지원 (fmp4 컨테이너 전용). 커스텀 인코딩 옵션에서 선택 가능하도록. | 낮 |
| 4 | 커스텀 인코딩 설정 UI | 사용자가 코덱, 비트레이트, 오디오 코덱, CRF 등을 직접 지정하는 고급 설정 페이지. | 낮 |

### 사용자 기능 관련

| # | 항목 | 상세 | 우선순위 |
|---|------|------|----------|
| 5 | 시청 기록 목록 조회 | `GET /api/user/history` 구현. DB에 `watch_history` 테이블과 `SaveWatchPosition`/`GetWatchPosition`은 구현됨. 목록 조회(`GetWatchHistory`)는 미구현. | 높 |
| 6 | 시청 기록 삭제 | `DELETE /api/user/history/{path}` 또는 전체 삭제. 개별/전체 삭제 기능. | 높 |
| 7 | 시청 기록 UI | History 페이지에서 영상 목록, 진행률 표시, 이어보기 링크, 삭제 버튼. | 높 |

### 자막 시스템 관련

| # | 항목 | 상세 | 우선순위 |
|---|------|------|----------|
| 8 | OpenAI Whisper API 테스트 | 구현 완료, API 키 설정 후 실환경 테스트 필요 | 중 |
| 9 | faster-whisper CUDA 테스트 | 구현 완료, NVIDIA GPU 환경에서 Docker 테스트 필요 | 중 |
| 10 | OpenAI 번역 테스트 | 구현 완료, API 키 설정 후 번역 품질 테스트 필요 | 중 |
| 11 | DeepL 번역 테스트 | 구현 완료, API 키 설정 후 번역 품질 테스트 필요 | 중 |

### 참고
- 시청 기록 관련은 FTML.md 섹션 7 (관리자 대시보드)과 섹션 8 (사용자 기능)에 스펙이 정의되어 있음
- API 스펙에 `GET /api/user/history`는 정의되어 있으나 아직 구현되지 않음
- `PUT /api/user/history/{path}` (재생 위치 저장)만 현재 동작 중
- 자막 시스템 #8-#11: Phase 4에서 구현은 완료하되 로컬 테스트 환경 한계로 추후 테스트. whisper.cpp SYCL + Gemini 번역만 로컬 테스트 완료 예정