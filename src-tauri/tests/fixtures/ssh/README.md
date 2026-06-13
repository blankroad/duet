# SSH 통합 테스트 픽스처

실제 sshd + rsync 컨테이너 위에서 duet 의 SSH 코드 경로(연결/인증, SFTP CRUD,
휴지통, same-host copy, 원격 검색)를 구동하는 통합 테스트용 픽스처.

테스트는 기본 `cargo test` 에서 **제외**된다 (`#[ignore]` + `DUET_SSH_IT=1` 게이트).
네트워크/도커가 없는 CI·오프라인 환경에 영향 없음.

## 실행

```bash
# 저장소 루트에서
bash scripts/ssh-it.sh
```

스크립트가 ① 테스트 키 생성(`keys/id_ed25519`) → ② `docker compose up -d --build --wait`
→ ③ `DUET_SSH_IT=1 cargo test --test 'ssh_it_*' -- --ignored` → ④ `docker compose down -v`.

특정 모듈만:

```bash
bash scripts/ssh-it.sh ssh_it_same_host_copy
```

## 큰 파일 / 다수 파일 stress (ROADMAP MVP-3)

크기·개수는 환경변수로 조절한다. 기본값은 가볍게(256MB / 2000개), ROADMAP 의
10GB / 1만개는 명시 opt-in:

```bash
DUET_SSH_IT_BYTES=10000000000 DUET_SSH_IT_COUNT=10000 \
  bash scripts/ssh-it.sh ssh_it_stress
```

## 컨테이너

| 항목 | 값 |
|---|---|
| 베이스 | `alpine:3.20` + `openssh-server` + `rsync` |
| 포트 | `127.0.0.1:2222 → 22` |
| 유저 | `duet`/`duetpass` (메인, authorized key 주입), `alt`/`altpass` (옵션) |
| 인증 | 비밀번호 + 공개키(ed25519) |

## 하니스 환경변수 (override)

| 변수 | 기본값 | 의미 |
|---|---|---|
| `DUET_SSH_IT` | (미설정) | `1` 이어야 테스트 실행. 아니면 skip |
| `DUET_SSH_IT_HOST` | `127.0.0.1` | 접속 호스트 |
| `DUET_SSH_IT_PORT` | `2222` | 접속 포트 |
| `DUET_SSH_IT_USER` | `duet` | 접속 유저 |
| `DUET_SSH_IT_PASS` | `duetpass` | 비밀번호 |
| `DUET_SSH_IT_KEY` | (미설정) | 개인키 경로 — 있으면 키 인증 테스트도 실행 |
| `DUET_SSH_IT_BYTES` | `268435456` | stress 큰 파일 바이트 수 |
| `DUET_SSH_IT_COUNT` | `2000` | stress 파일 개수 |

## 주의

- `keys/` 는 매 실행마다 생성되는 테스트 전용 키 — `.gitignore` 로 커밋 제외.
- 픽스처가 `docker compose` 를 셸 호출하는 것은 CLAUDE.md §9(앱의 시스템 ssh
  클라이언트 호출 금지)와 무관하다 — 앱 코드가 아니라 테스트 하니스다.
