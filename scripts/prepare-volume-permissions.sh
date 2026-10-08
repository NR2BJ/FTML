#!/bin/sh
# Debian의 일반 Docker에서 FTML 전용 볼륨만 백업하고 소유권을 이전한다.
set -eu
umask 077

if [ "${1:-}" != "--apply" ] || [ "$#" -ne 1 ]; then
    printf '%s\n' '사용법: sh scripts/prepare-volume-permissions.sh --apply' \
        '먼저 FTML 스택을 중지하세요. 전용 볼륨을 백업한 뒤 1000:1000으로 바꿉니다.' \
        '미디어 폴더는 마운트하거나 변경하지 않습니다.' >&2
    exit 2
fi

fail() { printf '%s\n' "$*" >&2; exit 1; }

data_volume=${FTML_DATA_VOLUME:-ftml_data}
models_volume=${FTML_MODELS_VOLUME:-whisper_models}
for volume in "$data_volume" "$models_volume"; do
    case "$volume" in
        ''|*[!a-zA-Z0-9_.-]*) fail "잘못된 볼륨 이름: $volume" ;;
    esac
done
[ "$data_volume" != "$models_volume" ] || fail '데이터와 모델 볼륨이 같으면 안 됩니다.'

security=$(docker info --format '{{json .SecurityOptions}}')
case "$security" in
    *rootless*|*userns*) fail 'Rootless/userns 환경은 UID 매핑을 먼저 확인해야 합니다. 자동 이전을 중단합니다.' ;;
esac

check_stopped() {
    for volume in "$data_volume" "$models_volume"; do
        running=$(docker ps -q --filter "volume=$volume")
        [ -z "$running" ] || fail "볼륨 $volume 사용 컨테이너가 실행 중입니다. 스택을 먼저 중지하세요."
    done
}

for volume in "$data_volume" "$models_volume"; do
    # 존재하지 않는 볼륨을 실수로 새로 만들거나 공유 NAS 전체를 변경하지 않는다.
    driver=$(docker volume inspect --format '{{.Driver}}|{{json .Options}}' "$volume")
    case "$driver" in
        'local|null'|'local|{}') ;;
        *) fail "볼륨 $volume 은 기본 local 볼륨이 아닙니다. 실제 저장 경로/공유 범위를 먼저 확인하세요." ;;
    esac
done
check_stopped

backup_root=${FTML_BACKUP_DIR:-"$HOME/ftml-backups"}
mkdir -p "$backup_root"
backup_dir=$(mktemp -d "$backup_root/permissions-XXXXXXXX")
printf '백업 위치: %s\n' "$backup_dir"

for volume in "$data_volume" "$models_volume"; do
    # 볼륨은 읽기 전용, 백업은 호스트의 현재 계정이 소유하는 파일로 남긴다.
    docker run --rm --network none --read-only --user 0:0 \
        --mount "type=volume,src=$volume,dst=/volume,readonly" \
        ubuntu:24.04 tar --numeric-owner -cpf - -C /volume . > "$backup_dir/$volume.tar"
    tar -tf "$backup_dir/$volume.tar" > /dev/null
done

# 백업 중 다른 작업이 서비스를 시작했으면 소유권을 변경하지 않는다.
check_stopped
docker run --rm --network none --read-only --user 0:0 \
    --mount "type=volume,src=$data_volume,dst=/data" \
    --mount "type=volume,src=$models_volume,dst=/models" \
    ubuntu:24.04 sh -ec '
        find /data /models -xdev -exec chown -h 1000:1000 {} +
    '

docker run --rm --network none --read-only --user 1000:1000 \
    --mount "type=volume,src=$data_volume,dst=/data" \
    --mount "type=volume,src=$models_volume,dst=/models" \
    ubuntu:24.04 sh -ec '
        for dir in /data /models; do
            file=$(mktemp "$dir/.ftml-permission-XXXXXX")
            trap '\''rm -f "$file"'\'' EXIT HUP INT TERM
            printf test > "$file"
            rm "$file"
            trap - EXIT HUP INT TERM
        done
    '
printf '%s\n' '전용 볼륨의 백업, 소유권 변경 및 UID 1000 쓰기 확인 완료. 이제 스택을 재배포하세요.'
