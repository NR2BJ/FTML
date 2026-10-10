# FTML · Folder Tree Media Library

폴더 구조 그대로 탐색·검색하고 브라우저에서 영상을 재생하는 개인용 미디어 라이브러리다. Debian Docker와 Intel Arc A380을 기준으로 관리한다.

## 주요 기능

- 폴더 탐색·파일 검색·이어 보기·다음 영상 재생
- 브라우저 코덱 지원에 따른 원본 재생, 오디오 변환, 하드웨어 HLS 변환
- 다중 음성 트랙·자막 선택·배속·A-B 반복·재생 정보·PiP
- ASS 효과 표시와 일반 자막 전환, SRT/VTT/ASS 내려받기
- 로컬 Whisper large-v3 INT8 추출, Qwen3-ASR 1.7B 비교 추출
- Gemini 번역·작품 용어 참고·영상별 작업 이력·일괄 작업
- 읽기 전용 미디어 탐색기, 통합 자막 패널, 사용자별 접근·자막 작업 권한

Whisper의 원음을 VAD로 잘라 내지 않는다. Silero는 선택적인 말소리 비교 진단만 수행한다. Qwen은 비교 기능이며 A380의 정확도·메모리·속도는 실제 영상으로 확인해야 한다. 번역은 Gemini만 사용하고 클라우드 음성 인식 키는 필요 없다.

## 배포

**[GHCR 이미지와 Portainer 편집기 배포 안내](docs/ghcr-portainer.md)**를 따른다. 기존 Git 스택은 Git 연결을 해제한 뒤 Portainer에서 YAML·폴더 경로·환경 변수를 직접 관리한다. 저장소의 `docker-compose.yml`은 첫 등록용 예시다.

GitHub Actions가 `main`의 세 서비스 이미지를 GHCR에 게시한다. 게시가 끝나면 Portainer에서 같은 `FTML_TAG`로 수동 업데이트한다. 서버에서 소스를 빌드할 필요가 없다.

```text
ghcr.io/nr2bj/ftml-frontend:<전체 커밋 SHA>
ghcr.io/nr2bj/ftml-backend:<전체 커밋 SHA>
ghcr.io/nr2bj/ftml-whisper:<전체 커밋 SHA>
```

처음 설치하는 경우 Docker Compose, 영상 폴더, `/dev/dri` 장치와 외부 볼륨 `ftml_data`, `whisper_models`, 네트워크 `homeserver-net`이 필요하다. 백엔드·음성 인식은 UID/GID `1000:1000`으로 실행한다. [볼륨 권한 안내](docs/container-permissions.md)에 따라 처음 한 번 권한을 준비한다. 기존 볼륨을 삭제하거나 다시 초기화하지 않는다.

`.env.example`에는 비밀 값이 없다. 관리자 암호는 직접 지정하고 JWT 키는 기존 값을 유지한다. 모델은 `whisper_models`, DB·생성/번역 자막·썸네일·변환 캐시는 `ftml_data`에 저장한다. 미디어 마운트는 읽기 전용이다. 영상 업로드·이동·삭제는 copyparty 등 별도 도구에서 처리하며 앱의 자막 추출·번역·삭제는 계속 가능하다.

직접 소스 빌드가 필요한 개발 환경은 `docker-compose.build.yml`을 추가한다. 기본 배포는 Linux amd64 + Intel GPU용이다. `docker-compose.nvidia.yml`은 기존 영상 변환용 보조 설정일 뿐 Qwen/Whisper CUDA 구성을 제공하지 않는다.

## 사용 안내

자막 추출·타임라인·ASS 효과·PiP·번역 보존·배포 후 확인 항목은 [자막 처리 안내](docs/subtitles.md)를 참고한다. Firefox 내장 PiP는 일반 자막을 표시할 수 있지만 ASS 효과 보존은 서비스의 Document PiP 지원 환경과 구분해야 한다.

| 구성 | 사용 기술 |
| --- | --- |
| 백엔드 | Go, chi, SQLite WAL |
| 화면 | React, TypeScript, Vite, Tailwind CSS |
| 영상 | FFmpeg, VAAPI, hls.js |
| 로컬 음성 인식 | OpenVINO GenAI, Whisper, Qwen3-ASR |
| 번역 | Gemini |
| 배포 | GitHub Actions, GHCR, Docker Compose / Portainer |

## 라이선스

프로젝트 코드는 MIT 라이선스다. 포함된 ASS 렌더러와 글꼴에는 각각의 라이선스가 적용된다. libass-wasm 저작권 고지는 배포 파일의 `ass-renderer/4.1.0/COPYRIGHT`에 제공한다. 모델과 의존 라이브러리에도 각 배포처의 라이선스가 적용된다.
