# CLAUDE.md — 작업 규칙

> **모든 코드 변경 전에 이 문서를 읽어야 합니다.**
> 새 세션에서 작업 시작할 때마다 이 파일 + `ARCHITECTURE.md`를 먼저 읽으세요.

## 절대 규칙 (Absolute Rules)

### 1. IPC 경계 엄수

프론트엔드(React) ↔ 백엔드(Rust) 통신은 **반드시 Tauri command를 통해서**.

- 프론트엔드는 절대 OS API / 파일시스템 / SSH 직접 호출 안 함
- 모든 위험한 작업은 백엔드에서 검증 후 실행
- 프론트엔드는 "사용자 의도를 표현"만, 백엔드가 "실제 실행" 담당

### 2. 백엔드 레이어 의존성 단방향

```
commands → services → core → fs → platform
                            └→ ssh
```

위 레이어는 아래만 import. 역방향 import 절대 금지.

### 3. 영구 삭제는 디폴트로 비활성화

- 모든 "삭제" 작업의 디폴트는 휴지통 이동 (`mv`)
  - 로컬: OS 휴지통 (`trash` crate)
  - 원격: `~/.duet-trash/<timestamp>/<original-path>/` 로 mv
- 영구 삭제(`rm`)는 설정에서 명시적으로 켜야만 가능
- 영구 삭제 활성화 상태에서도 추가 확인 다이얼로그 (단어 타이핑 요구)
- `std::fs::remove_*`, `tokio::fs::remove_*`, SSH `rm` 직접 호출 금지
- 모든 삭제는 `core::ops::DeleteOp` trait 통해서만

### 4. 모든 파괴적 작업은 undo 가능해야 함

- 복사/이동/이름변경/삭제 모두 작업 로그(`~/.duet/journal.jsonl`)에 기록
- 마지막 N개 작업은 `Ctrl+Z` 로 되돌릴 수 있어야 함
- "되돌릴 수 없는 작업"은 그 자체로 디자인 실패. 사용자 승인 후에만 허용

**복사/이동 Replace 덮어쓰기 (2026-06 예외, 사용자 승인):** 충돌 시 Replace 는 기존
파일을 `.bak` 으로 남기지 않고 **영구 덮어쓰기**한다 — 이 덮어쓰기는 undo 불가.
구현은 실패 안전을 위해 "기존을 임시 백업으로 옮김 → 복사/이동 → 성공 시 백업 영구삭제
(journal 미기록=undo 없음) / 실패 시 롤백(원본 복원)". Skip/KeepBoth 는 비파괴라 영향 없음.
(sync/repack 의 덮어쓰기는 여전히 .bak 보존 + undo 가능 — 이 예외는 copy/move 한정.)

### 5. SSH 자격증명은 메모리/로그에 노출 금지

- SSH agent (`SSH_AUTH_SOCK`) 또는 `~/.ssh/config` IdentityFile 우선 — 가능한 비밀번호 사용 자체를 회피
- `tracing` 로그에 자격증명 출력 금지 (`Debug` derive 시 주의)
- 자격증명을 디스크에 저장하려면 OS keychain (`keyring` crate) 사용

**비밀번호 IPC 전달 (2026-05 완화):** 사용자가 dialog 의 password input 에 직접 입력한 경우는 IPC 로 backend 에 전달 가능. 단 다음 모두 충족:
- input 은 `<input type="password">` (DOM 표시 마스킹)
- frontend store / localStorage / sessionStorage 에 저장 절대 금지 — 컴포넌트 local state 에만, command 호출 직후 clear
- backend command 인자 외 어디에도 영구화 금지, drop 시 zeroize 노력 (러스트 소멸 시점)
- 로그 출력 금지 (위 § 동일)
- OS-native secure prompt 가 불가능한 환경 (web/embed 등) 의 fallback 으로 정의 — 가능하면 keyring 캐시 후 재사용

이 완화는 "프론트엔드로 절대 전달 안 함" 의 원칙을 약화하지만, 실용성을 위한 의도된 trade-off. 이전 strict 정책으로 회귀 가능 (Task 7b: OS-native dialog).

### 6. 의존성 추가는 명시적 승인 필요

- `cargo add`, `pnpm add` 자동 실행 금지
- 새 의존성 추가 전: 이름 + 이유 + 다운로드 수 + 대안 검토 결과를 사용자에게
- `Cargo.toml` / `package.json` 수동 편집 후 사용자 확인

### 7. 직접 path 문자열 조작 금지

- Rust: 항상 `Path` / `PathBuf`. `format!("{}/{}", ...)` 결합 금지
- TypeScript: 경로 조작은 백엔드에 위임. 프론트엔드는 표시만
- 경로 구분자 분기는 `platform/` 모듈에서만

### 8. unsafe 사용 금지

- `unsafe` 블록은 `platform/` 의 OS API 호출에서만 허용
- 다른 곳에서 발견 시 즉시 거부
- `platform/` 에서 사용 시 주석으로 안전 조건 명시

### 9. 시스템 SSH 클라이언트 호출 금지

- 모든 SSH 연결은 `russh` 라이브러리로 (시스템 `ssh` 바이너리 호출 X)
- 원격 명령 실행은 russh의 exec 채널로 (시스템 `ssh user@host cmd` 호출 X)
- 파일 전송은 `russh-sftp` 또는 SCP-over-russh로 (시스템 `sftp`/`scp` 호출 X)
- ProxyJump는 russh nested session 으로 구현
- 이유: 사용자/OS별 SSH 클라이언트 환경 차이 (Windows OpenSSH 유무 등) 흡수
- `std::process::Command::new("ssh")` 등 발견 시 즉시 거부

## 작업 패턴

### 새 기능 추가 시

1. `ROADMAP.md` 에서 현재 단계 확인 — 범위 벗어나면 사용자에게 확인
2. 어느 레이어인지 먼저 답하기:
   - 프론트엔드만? 백엔드만? 둘 다?
   - 백엔드라면 어느 레이어 (commands/services/core/fs/ssh/platform)?
3. IPC 명세 먼저 정하기 (Tauri command 시그니처)
4. 백엔드 → 프론트엔드 순서로 구현
5. 테스트 먼저 — fs/core/ssh 레이어는 테스트 없이 머지 금지

### 코드 수정 시

1. 변경할 파일 먼저 전체 읽기
2. 변경 범위가 한 모듈을 넘으면 사용자에게 보고
3. 한 PR/커밋 = 한 가지 변경. 리팩토링 + 기능 추가 섞지 말 것

### 막혔을 때

- 추측해서 진행하지 말기. 사용자에게 질문
- OS별 동작, SSH 프로토콜 디테일, Tauri API 스펙은 추측 금지
- "아마 이렇게 하면 될 것 같다" 코드 작성 안 함

## 절대 하지 말 것

- ❌ `rm -rf`, `std::fs::remove_dir_all`, SSH `rm -rf` 직접 호출
- ❌ 사용자 홈 디렉토리에서 테스트 (`~`, `C:\Users\...`, `/home/$USER`)
- ❌ 백엔드 코드 없이 프론트엔드에서 fs/SSH 호출 시도 (Tauri의 `@tauri-apps/api/fs` 같은 거)
- ❌ 키바인딩 하드코딩 (모든 키는 설정 가능)
- ❌ 색상 하드코딩 — Tailwind theme + CSS variable 사용
- ❌ `unwrap()`, `expect()` 남발 — 에러는 IPC 경계까지 전파
- ❌ `console.log`, `println!` 디버그 출력 (배포 시 잡음). `tracing` (백) / `loglevel` (프) 사용
- ❌ 의존성에 `*` 버전, git 의존성 (재현 불가능)
- ❌ TypeScript에서 `any` 타입 (`unknown` 으로)
- ❌ React에서 `useEffect` 데이터 페칭 — Tauri command를 위한 hook 별도로
- ❌ 비밀번호/키를 `localStorage`, `sessionStorage`, IndexedDB에 저장
- ❌ 같은 호스트 SFTP 복사 시 본인 PC를 거쳐가기 (이게 TC의 핵심 문제, 절대 반복 금지)

## 코드 스타일

### Rust

- `cargo fmt` 통과
- `cargo clippy -- -D warnings` 통과
- 모듈 레벨 doc comment 필수 (`//! 이 모듈의 책임`)
- public API doc comment 필수 (`/// ...`)
- 함수 100줄 넘으면 분리 검토
- 한 파일 500줄 넘으면 분리 검토

### TypeScript / React

- `pnpm lint` 통과 (eslint + prettier)
- 컴포넌트는 함수형 + hooks
- props 타입은 `interface` 또는 `type`
- 한 파일 한 컴포넌트 (작은 헬퍼는 같이 가능)
- 컴포넌트 200줄 넘으면 분리 검토
- 비즈니스 로직은 `stores/` 또는 `hooks/` 로

## 커밋 메시지

```
<scope>: <짧은 설명>

<상세 설명, 필요 시>
```

scope 예시:
- `be/cmd`, `be/svc`, `be/fs`, `be/ssh`, `be/platform` (백엔드)
- `fe/ui`, `fe/store`, `fe/hook` (프론트엔드)
- `config`, `docs`, `build`, `ci`

## 테스트

### 백엔드

- 단위 테스트: 각 모듈 (`#[cfg(test)] mod tests`)
- fs 레이어: `MockFileSystem` 으로
- SSH 레이어: 실제 연결 안 하고 mock 또는 in-memory SSH 서버
- 통합 테스트는 `src-tauri/tests/`

### 프론트엔드

- Vitest + React Testing Library
- 컴포넌트 스냅샷 + 인터랙션
- Tauri command 호출은 모킹 (`@tauri-apps/api/mocks`)

테스트는 절대 실제 사용자 파일시스템 / 원격 서버 건드리지 않음.

## 문서 동기화

이 파일이나 `ARCHITECTURE.md`, `DESIGN.md`의 규칙과 코드가 충돌하면:
- 규칙이 우선. 코드를 고치거나, 사용자와 합의 후 규칙을 고침
- "코드는 이미 이렇게 되어있으니 규칙을 어기겠다" 금지
