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
#
# 사용자 환경 격리 (remote-35): 테스트는 HOME 을 저장소 안의 전용 폴더로 바꿔 실행한다.
# 그래서 앱 코드가 읽고 쓰는 `~/.ssh/known_hosts`·`~/.ssh/config`·설정 폴더가 사용자 것이
# 아니라 이 폴더의 것이 된다. known_hosts 는 실행마다 컨테이너의 호스트키로 새로 채운다
# (TOFU 학습 순서에 따라 키 인증 테스트가 실패하던 문제도 같이 사라진다).
# SSH agent 도 끊어 테스트 키만 쓰게 한다.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
fixture_dir="$repo_root/src-tauri/tests/fixtures/ssh"
key_path="$fixture_dir/keys/id_ed25519"
# 테스트 전용 HOME — keys/ 처럼 .gitignore 대상. 지우지 않고 실행마다 내용만 다시 쓴다.
it_home="$fixture_dir/it-home"
it_host="${DUET_SSH_IT_HOST:-127.0.0.1}"
it_port="${DUET_SSH_IT_PORT:-2222}"

# 1) 테스트 전용 키 생성 (없을 때만). 픽스처는 .pub 만 COPY.
mkdir -p "$fixture_dir/keys"
if [ ! -f "$key_path" ]; then
  ssh-keygen -t ed25519 -N "" -f "$key_path" -C "duet-ssh-it" >/dev/null
fi

# 2) 컨테이너 기동 (healthy 까지 블록). 종료 시 정리.
cd "$fixture_dir"
docker compose up -d --build --wait
trap 'docker compose -f "$fixture_dir/docker-compose.yml" down -v >/dev/null 2>&1 || true' EXIT

# 3) 격리 HOME + known_hosts 시드. 호스트키는 네트워크로 받지 않고(ssh-keyscan 불필요)
#    컨테이너 안의 공개키 파일을 직접 읽는다. 포트가 22 가 아니면 `[host]:port` 표기.
mkdir -p "$it_home/.ssh"
chmod 700 "$it_home" "$it_home/.ssh"
if [ "$it_port" = "22" ]; then
  host_pattern="$it_host"
else
  host_pattern="[$it_host]:$it_port"
fi
known_hosts="$it_home/.ssh/known_hosts"
: >"$known_hosts"
for pub in $(docker compose exec -T ssh sh -c 'ls /etc/ssh/ssh_host_*_key.pub'); do
  # 공개키 줄 = "<type> <base64> <comment>" → "<pattern> <type> <base64>"
  docker compose exec -T ssh cat "$pub" | awk -v h="$host_pattern" '{print h, $1, $2}' >>"$known_hosts"
done
chmod 600 "$known_hosts"
if [ ! -s "$known_hosts" ]; then
  echo "ssh-it: 컨테이너 호스트키를 읽지 못함" >&2
  exit 1
fi

# 4) 게이트된 IT 실행. 인자가 있으면 해당 바이너리만, 없으면 ssh_it_* 전부.
#    cargo/rustup 은 HOME 으로 도구 위치를 찾으므로, HOME 을 바꾸기 전에 원래 위치를 고정한다.
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export HOME="$it_home"
unset SSH_AUTH_SOCK
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
