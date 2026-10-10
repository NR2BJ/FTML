#!/usr/bin/env bash
set -euo pipefail
service=${1:?서비스 이름 필요}
image=${2:?이미지 이름 필요}

case "$service" in
  backend)
    trap 'docker logs ftml-image-check; docker rm -f ftml-image-check >/dev/null' EXIT
    docker run -d --name ftml-image-check -e ADMIN_PASSWORD=ci-only-password "$image"
    for attempt in {1..30}; do
      if docker exec ftml-image-check curl -fsS http://localhost:8080/api/health; then exit 0; fi
      sleep 2
    done
    exit 1
    ;;
  frontend)
    # nginx의 backend 이름 조회만 제공하며 운영 서버에는 연결하지 않는다.
    trap 'docker logs ftml-image-check; docker rm -f ftml-image-check >/dev/null' EXIT
    docker run -d --name ftml-image-check --add-host backend:127.0.0.1 "$image"
    for attempt in {1..15}; do
      if docker exec ftml-image-check curl -fsS http://localhost/; then exit 0; fi
      sleep 1
    done
    exit 1
    ;;
  whisper)
    test_dir=$(mktemp -d)
    trap 'rm -rf "$test_dir"' EXIT
    cp whisper/test_*.py "$test_dir/"
    chmod 755 "$test_dir"
    chmod 644 "$test_dir"/*.py
    docker run --rm --entrypoint python3 "$image" -c \
      'import openvino_genai, optimum.intel, qwen_asr, torch, torchvision, silero_vad, onnxruntime; assert torch.version.cuda is None; print("ASR 의존성 로딩 완료")'
    # 시험 코드는 읽기 전용으로 붙이고, 실제 배포 모듈은 이미지의 /app에서 읽는다.
    docker run --rm --entrypoint python3 -e PYTHONPATH=/app -e HF_HUB_OFFLINE=1 -v "$test_dir:/tests:ro" "$image" \
      -m unittest discover -s /tests -p 'test_*.py' -v
    ;;
  *) echo "알 수 없는 서비스: $service" >&2; exit 1 ;;
esac
