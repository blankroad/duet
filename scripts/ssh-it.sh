#!/usr/bin/env bash
#
# SSH 통합 테스트 러너 — sshd+rsync 컨테이너를 띄우고 게이트된 IT 스위트 실행.
#
# 사용:
#   bash scripts/ssh-it.sh                 # 전체 ssh_it_* 실행
#   bash scripts/ssh-it.sh ssh_it_stress   # 특정 테스트 바이너리만
#
# stress 크기/개수 조절:
#   DUET_SSH_IT_BYTES=10000000000 DUET_SSH_IT_COUNT=10000 \
#     bash scripts/ssh-it.sh ssh_it_stress
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_dir="$repo_root/src-tauri/tests/fixtures/ssh"
key_path="$fixture_dir/keys/id_ed25519"

# 1) 테스트 전용 키 생성 (없을 때만). 픽스처는 .pub 만 COPY.
mkdir -p "$fixture_dir/keys"
if [ ! -f "$key_path" ]; then
  ssh-keygen -t ed25519 -N "" -f "$key_path" -C "duet-ssh-it" >/dev/null
fi

# 2) 컨테이너 기동 (healthy 까지 블록). 종료 시 정리.
cd "$fixture_dir"
docker compose up -d --build --wait
trap 'docker compose -f "$fixture_dir/docker-compose.yml" down -v >/dev/null 2>&1 || true' EXIT

# 3) 게이트된 IT 실행. 인자가 있으면 해당 바이너리만, 없으면 ssh_it_* 전부.
cd "$repo_root/src-tauri"
export DUET_SSH_IT=1
export DUET_SSH_IT_KEY="$key_path"

if [ "$#" -gt 0 ]; then
  test_args=()
  for t in "$@"; do
    test_args+=(--test "$t")
  done
  cargo test "${test_args[@]}" -- --ignored --nocapture
else
  cargo test --test 'ssh_it_*' -- --ignored --nocapture
fi
