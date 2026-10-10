# Debian 파일 권한과 안전한 재배포

## 확인한 쓰기 경로

기본 Compose의 경로 기준이다. `DATA_PATH`나 `SUBTITLE_PATH`를 별도로 바꾸면 저장 위치도 바뀐다.

| 기능 | 읽기/쓰기 위치 | 미디어 폴더 변경 |
|---|---|---|
| 파일 탐색, 검색, 직접 재생, 영상 정보 조사 | `/media` 읽기 | 없음 |
| 내장 자막 추출, 동영상 옆의 외부 자막 읽기/변환 | `/media` 읽기, 변환 결과는 응답으로 전송 | 없음 |
| 자막 생성/번역/업로드/삭제 및 이전 버전 보관 | `/data/subtitles/<경로 해시>/` | 없음 |
| 썸네일 | `/data/thumbnails/` | 없음 |
| HLS 조각, 목록, FFmpeg 로그 | `/data/hls/<작업 ID>/` | 없음 |
| 계정/설정/API 키/작업/시청 이력 | `/data/videostream.db` 및 SQLite WAL 파일 | 없음 |
| 자막 인식용 임시 음성/업로드 임시 자료 | 컨테이너 `/tmp` | 없음 |
| Whisper 모델 다운로드 | `whisper_models` 볼륨의 `/models/hub` 등 | 없음 |
| Whisper/Intel/Numba의 사용자 캐시 | `/home/ftml/.cache` | 없음, 컨테이너 교체 시 사라질 수 있음 |

NFO를 생성하거나 원본 영상에 자막을 삽입하는 로직은 없다. 원본 폴더에 자막/썸네일/변환 캐시를 자동 저장하지도 않는다. **미디어 업로드·이동·삭제·폴더 생성·휴지통 API와 화면을 제거했으므로 백엔드의 `/media`는 읽기 전용이다.** 파일 관리는 copyparty 등 별도 도구로 한다. 과거 `.trash`와 기존 미디어는 자동 정리하지 않는다. Whisper는 백엔드가 추출한 음성을 HTTP로 받아 처리하므로 미디어 마운트를 제거했다.

관련 코드: `backend/internal/api/handlers/files.go`, `subtitle.go`, `internal/subtitle/{whisper,translate}/service.go`, `internal/ffmpeg/{hls,thumbnail}.go`, `whisper/server.py`.

## 적용한 실행 권한

- 백엔드와 Whisper는 Dockerfile 및 Compose 모두 `1000:1000`으로 실행한다. 환경 변수 `PUID`만 선언하고 아무 일도 하지 않는 방식이 아니다.
- FFmpeg 자식 프로세스도 같은 UID/GID로 실행한다. 기본적인 로컬 Linux 파일시스템에서 새 파일 소유자는 UID 1000이다. GID는 기본 1000이지만 상위 폴더에 setgid가 있으면 그 폴더의 그룹을 상속한다. 기존 파일의 소유권을 자동 변경하지 않는다.
- `id`가 표시하는 사용자/그룹 이름은 이미지 안의 계정 목록에 따라 호스트와 다를 수 있다. 이름이 아니라 숫자 UID/GID 1000을 확인한다.
- 기존 볼륨/미디어 파일의 소유권은 `USER`나 `user:` 설정만으로 바뀌지 않는다. 실행할 때 전체 미디어를 자동으로 `chown`하거나 `chmod 777` 하지 않는다.
- Whisper 모델 볼륨 이름과 내부 자료는 유지하고 마운트 위치만 `/root/.cache/huggingface`에서 `/models`로 바꾼다. `HF_HOME=/models`, `HF_HUB_CACHE=/models/hub`를 명시해 기존 모델을 재사용한다. HOME/Numba 캐시도 쓰기 가능한 위치를 사용한다.
- `no-new-privileges`를 적용한다. GPU는 root 대신 실제 장치 소유 그룹을 보조 그룹으로 부여한다. 보조 그룹은 새 일반 파일의 기본 GID를 바꾸지 않는다.
- 프론트엔드는 미디어/데이터 볼륨이 없는 기존 Nginx 구성을 유지한다. Nginx의 root 관리 프로세스까지 모두 일반 사용자로 바꾸었다는 뜻은 아니다.

Docker rootless 또는 `userns-remap`, NFS/SMB, NAS ACL 환경은 숫자 1000이 그대로 호스트 사용자로 대응하지 않을 수 있다. 아래 이전 도구는 일반 Docker의 기본 local 볼륨만 대상으로 하고 그 밖의 환경은 거부한다. 호스트의 실제 마운트/ACL은 서버에서 별도로 확인해야 한다.

## 재배포 전 준비

**이미 UID/GID 1000으로 이전한 서버는 권한 이전을 반복하지 않는다.** 현재 배포는 [GHCR·Portainer 안내](ghcr-portainer.md)를 따른다. 이번에는 세 이미지를 갱신하고 편집기의 미디어 마운트를 읽기 전용으로 변경한다.

아래 소유권 이전 절차는 과거 root 실행 버전에서 아직 이전하지 않은 설치에만 해당한다. root 소유 SQLite/모델 캐시를 쓰는 상태라면 전용 볼륨 준비가 필요하다.

Debian 호스트에서 실행한다. Docker 권한이 없다면 Docker 명령에 `sudo`를 사용한다. 아래 `MEDIA_PATH`는 실제 영상 폴더로 바꾼다.

```sh
stat -c '%u:%g %a %n' /실제/영상/폴더
stat -c '%u:%g %a %n' /dev/dri/*
docker volume inspect ftml_data whisper_models
```

Portainer 스택 환경 변수 또는 `.env`에 다음을 설정한다. `RENDER_GID`와 `VIDEO_GID`는 위에서 출력한 **renderD*와 card*의 실제 GID**를 각각 입력한다. 1000이나 흔히 쓰이는 109/44라고 추측하지 않는다. GPU가 여러 개라면 사용할 장치의 그룹을 확인한다.

```env
MEDIA_PATH=/실제/영상/폴더
RENDER_GID=실제_render_그룹번호
VIDEO_GID=실제_card_그룹번호
```

영상 폴더와 하위 파일에 UID 1000의 읽기 권한, 폴더 통과 권한이 필요하다. 앱에는 미디어 쓰기 권한이 필요하지 않다. `chown -R`로 미디어 전체의 소유권을 덮어쓰지 말고, 필요한 경로만 호스트 정책에 맞춰 소유권 또는 ACL을 조정한다. setgid/기본 ACL도 함께 확인한다.

## 기존 전용 볼륨 이전

`scripts/prepare-volume-permissions.sh`는 중지된 전용 볼륨 **두 개만** 읽어 백업하고, 그 안의 소유권을 1000:1000으로 바꾼다. 미디어 폴더, GPU, Docker 소켓은 임시 컨테이너에 마운트하지 않는다. root 임시 컨테이너는 이 일회성 관리 작업에만 사용하고 삭제한다. 심볼릭 링크를 따라 외부 대상으로 소유권을 변경하지 않으며 모델의 링크 구조도 유지한다. `chmod`는 수행하지 않지만 소유권 변경에 따른 setuid/setgid 같은 특수 비트의 해제는 운영체제 규칙을 따른다.

백업은 기본 `$HOME/ftml-backups/permissions-*/`에 만든다. 모델 전체도 포함하므로 여유 공간이 충분한지 먼저 확인한다. DB/API 키/개인 설정이 포함되므로 백업은 비공개로 보관한다. 실행 중인 컨테이너, 없는 볼륨, NFS/바인드 기반 local 드라이버 옵션, rootless/userns, 백업 실패를 발견하면 변경 전에 중단한다. 소유권 변경 단계 자체는 트랜잭션이 아니므로 중간 실패 시 오류를 해결하고 다시 실행하거나 백업으로 복구한다.

### Portainer에서 관리하는 경우

1. 최신 저장소에서 위 스크립트를 준비한다. 서버에 별도 작업 사본을 복제해도 되지만 그 사본에서 `docker compose up`으로 같은 서비스를 중복 실행하지 않는다.
2. Portainer에서 이 FTML 스택을 중지한다. 스택/볼륨을 삭제하지 않는다. 자동 갱신도 멈춘다.
3. 실제 마운트가 아래 볼륨 이름과 일치하는지 확인한 뒤 Debian 호스트에서 실행한다.

```sh
sh scripts/prepare-volume-permissions.sh --apply
```

기존 외부 볼륨 이름이 다르면 `FTML_DATA_VOLUME=실제이름 FTML_MODELS_VOLUME=실제이름`을 앞에 지정한다. 저장소 기본값은 `ftml_data`, `whisper_models`다. 다른 서비스와 공유하는 볼륨에는 실행하지 않는다.

4. 스택 환경 변수에 GPU 그룹 번호를 설정하고 [GHCR·Portainer 안내](ghcr-portainer.md)에 따라 게시가 완료된 세 이미지를 같은 SHA로 갱신한다. 미디어 마운트는 `read_only: true`로 둔다.
5. 아래 배포 후 확인을 수행한다.

### 직접 Compose로 관리하는 경우

**기존과 같은 Compose 프로젝트 이름, 파일 및 `.env`**를 사용한다. Portainer 스택에는 위 절차를 사용한다. 아래 `config` 검사가 실패하면 중지/이전을 진행하지 않고 환경 변수부터 수정한다.

```sh
git pull --ff-only origin main
docker compose config -q
docker compose pull
docker compose stop
sh scripts/prepare-volume-permissions.sh --apply
docker compose up -d --no-build --force-recreate
docker compose ps
docker compose logs --tail=100 ftml-backend ftml-whisper
```

한 명령이 실패하면 다음 단계로 진행하지 않는다. `down -v`, `volume rm`, `volume prune`는 사용하지 않는다. 새 설치도 외부 볼륨을 만든 뒤 이 준비 도구를 실행할 수 있다. 기존 데이터가 없다면 백업은 빈 볼륨의 자료만 포함한다.

## 배포 후 확인

직접 Compose이면 다음 명령을 사용한다. Portainer이면 각 컨테이너의 Console에서 `id` 등의 내부 명령을 실행하거나 `docker exec 실제컨테이너이름 ...`을 사용한다.

```sh
docker compose exec ftml-backend id
docker compose exec ftml-whisper id
docker compose exec ftml-backend sh -ec 'test -r /media; test -x /media; test -w /data; stat -c "%u:%g %a %n" /data /data/videostream.db; ls -ln /dev/dri'
docker compose exec ftml-whisper sh -ec 'test -w /models; test -w "$HOME"; test -w "$NUMBA_CACHE_DIR"; printf "%s\n" "$HF_HOME" "$HF_HUB_CACHE"; ls -ln /dev/dri'
docker compose exec ftml-backend vainfo --display drm --device /dev/dri/renderD128
```

UID/GID가 1000인지, 실제 GPU 그룹이 보조 그룹에 있는지 확인한다. GPU 장치 경로가 다르면 `vainfo`의 경로를 바꾼다. 이어서 실제 영상 재생/GPU 변환, 자막 생성/번역을 확인한다. 미디어 마운트의 읽기 전용 여부는 `docker inspect 실제백엔드이름 --format '{{json .Mounts}}'`에서 `Destination: /media`의 `RW: false`로 확인한다. 실제 미디어 파일을 만들어 검사하지 않는다. Whisper 로그에 모델 쓰기 거부나 `/root` 접근 오류가 없어야 한다. UID 1000 표시는 앱 로그인 계정과 무관하며 관리자/일반 사용자 모두 서버의 파일 접근은 같은 OS 계정으로 수행한다.

## 읽기 전용 미디어

현재 Compose는 `/media`에 `read_only: true`를 고정한다. 자막·캐시는 쓰기 가능한 별도 `/data`에 저장하므로 추출·번역·자막 삭제는 유지된다. Git에서 분리한 Portainer 스택은 이 변경이 자동 적용되지 않으므로 Editor에서 직접 수정한다.

`bind.create_host_path: false`로 존재하지 않는 영상 경로를 Docker가 root 소유의 빈 폴더로 자동 생성하지 못하게 했다. 경로가 잘못되었거나 저장 장치가 준비되지 않았다면 호스트에서 먼저 확인한다. 이미 존재하는 빈 마운트 지점까지 탐지하는 기능은 아니므로 NAS/외장 장치의 실제 마운트 여부도 확인해야 한다.

## 공식 근거

- [Docker Compose의 user, group_add, 볼륨 설정](https://docs.docker.com/reference/compose-file/services/)
- [Docker 볼륨 보존과 백업](https://docs.docker.com/engine/storage/volumes/)
- [Hugging Face 캐시 환경 변수](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables)
