# GHCR 이미지와 Portainer 편집기 배포

이제 GitHub는 이미지 빌드만 담당한다. 서버의 폴더·포트·GPU 그룹·환경 변수는 **Portainer의 스택 편집기에서 직접 수정**한다. 저장소의 `docker-compose.yml`은 최초 전환용 예시이며 Git 연결을 해제한 스택을 덮어쓰지 않는다.

## 이미지

| 서비스 | 이미지 |
| --- | --- |
| 화면 | `ghcr.io/nr2bj/ftml-frontend` |
| 백엔드 | `ghcr.io/nr2bj/ftml-backend` |
| 로컬 음성 인식 | `ghcr.io/nr2bj/ftml-whisper` |

Debian + Intel Arc용 `linux/amd64`를 빌드한다. Mac ARM용 실행 이미지는 제공하지 않는다. 모델 가중치는 이미지에 넣지 않고 기존 `whisper_models` 볼륨에 내려받는다. 개인 미디어·DB·API 키·`.env`·개발 캐시는 빌드에 포함하지 않는다.

`main`에 푸시하면 GitHub Actions의 **GHCR images**가 검사·빌드·이미지 실행 시험을 수행한다. 세 이미지와 Go/화면 검사가 모두 통과한 뒤 `latest`를 갱신한다. 커밋 전체 SHA 태그도 제공한다. 배포에는 **성공한 실행의 Summary에 표시된 같은 SHA를 세 서비스에 공통 적용**하는 것을 권장한다. `latest` 세 개의 갱신은 원자적이지 않으므로 게시 도중 배포하면 버전이 섞일 수 있다. GitHub Actions 성공을 확인한 뒤 업데이트한다.

GitHub 공개 저장소와 GHCR 공개 여부는 별개다. 최초 게시 후 GitHub 프로필 → Packages → 각 `ftml-*` → Package settings → Change visibility에서 **Public**으로 지정한다. 공개 이미지라면 Portainer에 GitHub 토큰이 필요 없다. 이미지가 비공개인 상태에서는 `denied`가 발생하므로 공개 여부부터 확인한다. 기존 만료 토큰으로 등록한 GHCR 인증이 있으면 익명 접근을 방해할 수 있으니 해당 레지스트리 설정도 확인한다.

## 기존 Git 스택 전환

1. 실행 중 추출·번역을 마무리한다. 기존 스택 YAML과 **환경 변수**를 Portainer에서 내려받거나 별도 기록한다. 기존 컨테이너 이미지 ID도 기록해 초기 전환 실패 때 되돌릴 수 있게 한다.
2. 백엔드를 중지한 상태에서 `ftml_data` 볼륨 전체를 백업한다. 실행 중 SQLite 파일 하나만 복사하면 WAL 변경이 빠질 수 있다. 미디어와 모델 볼륨을 삭제하거나 초기화하지 않는다.
3. GitHub Actions의 이미지 게시 성공과 세 패키지 공개 상태를 먼저 확인한다.
4. Portainer → Stacks → 기존 FTML 스택 → **Detach from Git**을 선택한다. Git 연결 해제는 되돌릴 수 없으나 컨테이너·외부 볼륨을 삭제하는 작업은 아니다. 기존 `.env`나 추가 Compose 파일은 자동 보존되지 않으므로 1번의 환경 변수를 확인한다.
5. 같은 스택의 **Editor**에서 저장소의 새 `docker-compose.yml` 내용을 기준으로 변경한다. `build:` 대신 `image:`를 사용하며 미디어 경로와 외부 볼륨 이름은 유지한다. 예전 서비스 이름을 쓰고 있다면 아래 이름 전환 절차를 먼저 따른다.
6. 아래 환경 변수를 확인하고 **Update the stack**을 실행한다. `latest`를 쓰면 이미지 다시 받기 옵션(Re-pull image / Pull latest image)을 켠다. SHA 변경 시에도 새 이미지가 정상적으로 받아졌는지 확인한다.
7. 세 컨테이너의 상태와 로그를 확인하고 브라우저를 새로고침한다. 로그인·영상 목록·재생·기존 자막·작업 이력이 유지되는지 확인한다.

`Detach from Git`이 없는 구버전에서는 기존 스택의 컨테이너를 중지한 뒤 Web editor 방식으로 옮겨야 한다. 같은 DB 볼륨을 두 백엔드가 동시에 열지 않도록 한다. 이 경우 기존 스택 삭제 시 **볼륨 삭제 옵션을 선택하지 않는다**. 버전별 화면 차이가 있으면 먼저 Portainer 버전을 확인한다.

| 환경 변수 | 이번 서버 설정 |
| --- | --- |
| `FTML_TAG` | 성공한 게시 실행의 전체 커밋 SHA, 또는 `latest` |
| `MEDIA_PATH` | 기존 Debian 영상 폴더의 절대 경로 |
| `FTML_PORT` | 기존 값, 기본 `7979` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | 기존 관리자 설정 유지. 암호 미입력 시 배포 중단 |
| `JWT_SECRET` | 기존 값 유지. 비어 있으면 재시작 후 재로그인 필요 |
| `RENDER_GID` | 사용자 서버에서 확인한 `992` |
| `VIDEO_GID` | 사용자 서버에서 확인한 `44` |
| `WHISPER_SPEECH_BOUNDARIES` | `true` 기본값. Whisper 긴 선행 무음 보정, 문제 시 `false` |
| `WHISPER_GAP_RETRY_SECONDS` | `0` 권장. 기존 값이 있으면 확인 |

`ftml_data`, `whisper_models`는 기존 외부 볼륨 이름 그대로다. 이미 UID/GID 1000으로 이전했다면 이번에 다시 전체 파일의 소유권을 바꿀 필요가 없다. 다른 볼륨 이름을 쓰던 설치는 YAML의 외부 이름을 실제 값과 맞춘다.

네트워크는 외부 `homeserver-net` 대신 Compose의 스택별 기본 네트워크를 사용한다. 스택 이름이 `ftml`이면 보통 `ftml_default`다. 현재 YAML의 `networks: default`와 `aliases`는 이 기본 네트워크 안에서 이전 내부 주소를 보존하기 위한 설정이며 외부 네트워크를 연결하지 않는다. 서비스는 새 이름으로도 접속할 수 있고, 기존 이미지의 `backend:8080` 및 DB에 저장된 `whisper:8178`도 계속 사용할 수 있다. 외부 역방향 프록시가 `frontend:80` 같은 컨테이너 이름으로 접속하고 있었다면 연결이 끊길 수 있으므로, 게시한 호스트 포트(기본 7979)로 접근하도록 별도로 확인한다. 기존 공유 네트워크 자체는 삭제하지 않는다. [Docker 네트워크 별칭 안내](https://docs.docker.com/reference/compose-file/services/#aliases).

## 서비스·컨테이너 이름 전환

현재 YAML은 서비스 키와 `container_name`을 모두 `ftml-frontend`, `ftml-backend`, `ftml-whisper`로 맞춘다. `-1` 접미사가 붙지 않는다. 이미지·외부 볼륨 이름과 저장 데이터는 바꾸지 않는다. 고정 컨테이너 이름은 같은 Docker 호스트에서 중복 사용할 수 없으며 서비스 복제에도 사용하지 않는다.

예전 서비스 키 `frontend`, `backend`, `whisper`에서 바꾸는 경우에는 단순 이미지 교체가 아니라 새 서비스 생성으로 처리될 수 있다. 기존 컨테이너가 남아 포트나 DB를 중복 사용하지 않게 **첫 전환 때만** 아래 절차를 따른다.

1. 진행 중 추출·번역과 재생을 마무리한다. Portainer의 현재 YAML과 환경 변수는 보관한다.
2. 예전 FTML 컨테이너 세 개를 중지하고 제거한다. 스택 자체나 볼륨을 삭제하지 않는다. 실제 이름이 아래와 같을 때만 다음 명령을 사용한다.

```sh
docker stop --time 120 ftml-frontend-1 ftml-backend-1 ftml-whisper-1
docker rm ftml-frontend-1 ftml-backend-1 ftml-whisper-1
```

3. 같은 Portainer 스택의 Editor에 새 YAML을 넣고 기존 환경 변수를 유지하여 업데이트한다. 이미지 다시 받기를 켠다. `ftml_data`, `whisper_models`는 그대로 연결한다. 이미 새 이름으로 전환했다면 2번은 반복하지 않는다.
4. 새 이름의 컨테이너 세 개가 정상인지, 로그인·기존 자막·시청 이력·음성 인식 연결이 유지되는지 확인한다. 서비스 라벨로 조회하는 명령도 앞으로 `com.docker.compose.service=ftml-whisper`처럼 바꾼다.

위 `docker rm`에는 `-v`가 없으며 저장 데이터가 있는 외부 볼륨을 지우지 않는다. 업데이트에 실패했을 때도 볼륨을 초기화하지 않는다. 이전 YAML로 되돌려야 한다면 새 이름의 컨테이너부터 중지하여 동일 DB에 두 백엔드가 동시에 접근하지 않게 한다.

## 다음 업데이트와 복구

이번 읽기 전용 변경은 **Portainer Editor의 ftml-backend → volumes → /media 항목에 `read_only: true`를 직접 설정**한다. 짧은 표기라면 `/실제/영상/폴더:/media:ro`다. 예전 `MEDIA_READ_ONLY` 참조는 제거한다. 코드에서 미디어 쓰기 API도 제거했으며, 기존 미디어와 과거 `.trash`는 삭제하지 않는다.

Whisper의 `environment` 목록에 `WHISPER_SPEECH_BOUNDARIES=${WHISPER_SPEECH_BOUNDARIES:-true}`를 추가하면 Portainer 환경 변수로 보정을 끌 수 있다. 미지정 시에도 서버 기본값은 켜짐이다. 자막과 시청 이력은 기존 볼륨을 유지한다.

앞으로는 저장소에서 서버 경로를 수정하지 않는다. 이미지 게시가 끝나면 Portainer에서 `FTML_TAG`만 변경하고 수동 업데이트한다. 스택 YAML·환경 변수는 Portainer에 남는다.

문제가 있으면 직전 정상 SHA로 `FTML_TAG`를 되돌린다. `docker compose down -v`, 볼륨 삭제, 모델 캐시 초기화는 하지 않는다. 이번 버전은 기존 자막·작업·사용자 이력을 보존하지만 **사용하지 않는 OpenAI 음성 인식 키와 이전 Whisper 모델 선택 설정은 DB에서 삭제**한다. 클라우드 연결 ID는 이력을 위해 비활성 상태로 남긴다. 구버전의 클라우드 기능까지 복구해야 한다면 배포 전 백업이 필요하다.

서버 터미널에서 Compose 파일을 따로 관리하는 경우에는 아래와 같다. Portainer 관리 스택과 동시에 실행하지 않는다.

```sh
docker compose pull
docker compose up -d --no-build
docker compose ps
```

소스에서 직접 빌드하는 개발 경로만 별도 유지한다.

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 음성 인식 설정

설정 → 로컬 음성 인식에서 서버 주소 `http://whisper:8178`를 확인한다. 지원되는 기존 연결은 그대로 유지하고, 없으면 기본 로컬 연결을 자동 등록한다. 클라우드 음성 인식 요청은 지원하지 않는다. Gemini 키는 번역용으로 계속 사용한다. 불안정한 작품 자동 검색은 제거했고 저장된 용어 사전은 보존한다.

Whisper는 `OpenVINO/whisper-large-v3-int8-ov`로 고정한다. Qwen은 **영상 → 자막 작업 → 추출 모델**에서 1.7B를 선택한다. ASR 0.6B 선택은 제거했지만 별도의 시각 정렬 모델 ForcedAligner 0.6B는 계속 필요하다. 기본 모델 다운로드도 첫 작업까지 미루므로 이미지 실행 검사의 성공은 GPU 추론 성공을 뜻하지 않는다. 첫 Qwen 비교는 단일 영상에서 실시하고 영상 변환과 동시에 실행하지 않는 편이 좋다.

FP16은 같은 Whisper의 더 높은 정밀도 가중치이지 차세대 모델이 아니다. 공식 FP16 배포 크기는 약 3.1GB지만 이것이 전체 실행 VRAM은 아니다. A380 6GB에서의 여유는 추론 임시 메모리·단어 시각·동시 영상 변환에 따라 달라진다. 무조건 못 들어간다거나 인식이 확실히 좋아진다고 단정하지 않고, 이번에는 INT8을 유지한다.

공식 자료: [Portainer Git 연결 해제](https://docs.portainer.io/user/docker/stacks/edit), [GHCR 인증·공개 설정](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [OpenVINO Whisper FP16](https://huggingface.co/OpenVINO/whisper-large-v3-fp16-ov/tree/main).
