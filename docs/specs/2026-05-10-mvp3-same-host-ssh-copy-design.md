# MVP-3 Design: 같은 호스트 SSH 복사 최적화

**Status:** Approved (브레인스토밍 합의 완료, plan 작성 단계)
**Date:** 2026-05-10
**Scope:** ROADMAP MVP-3 6 항목 + progress UI

## Goal

같은 SSH 호스트 안 SSH↔SSH 복사가 본인 PC를 거치지 않고 서버에서 직접 일어난다. TC 대비 핵심 차별점.

## 완료 조건

- 양쪽 패널의 SSH source 가 같은 host_ip (다른 user OK) 면 active connection 의 SSH 채널에서 `rsync` 또는 `cp -a` 직접 실행 — relay 안 거침
- rsync 가 원격에 있으면 우선 사용, 없으면 `cp -a` fallback
- rsync 사용 시 진행률 % + bytes_done/total + speed + ETA 가 ProgressModal 에 실시간 표시
- 같은-host exec 실패 시 silent relay 절대 안 함 — hard error toast
- 충돌은 MVP-2 와 동일 자동 backup (`.bak.<UTC ts>`) — SFTP rename 으로 처리
- ConfirmDialog 가 사용자에게 어떤 strategy 로 갈지 미리 표시 ("same-host (fast)" vs "relay (via this PC)")
- backend `core/copy_strategy`, `core/copy_progress`, `ssh/remote_exec` 단위 테스트 통과
- CLAUDE.md §9 (시스템 ssh 호출 금지) + DON'T (silent relay 금지) 준수

## Key decisions (brainstorming)

| # | 질문 | 결정 |
|---|---|---|
| 1 | Copy backend 선택 | **rsync 우선 + cp -a fallback** — rsync 있으면 진행률 + resume + delta, 없으면 단순 cp |
| 2 | Progress UI scope | **MVP-3 에서 % 까지 포함** — rsync `--info=progress2` 파싱 + ProgressEvent emit + ProgressModal 확장 |
| 3 | 실패 시 fallback 정책 | **Hard error** — silent relay 절대 안 함 (CLAUDE.md DON'T). 사용자가 명시 결정 필요하면 별도 dialog (MVP-3 범위 외) |
| 4 | 충돌 정책 | **MVP-2 와 동일 자동 backup** — SFTP rename `.bak.<UTC ts>` → cp/rsync. UndoCopy.backups_to_restore 에 기록 |

---

## Architecture overview

### 새 백엔드 모듈

- `core/copy_strategy.rs` — `CopyStrategy` enum + `decide(src, dst)` 함수. ARCHITECTURE.md 의 인라인 plan_copy 코드를 모듈화.
- `ssh/remote_exec.rs` — russh `Handle` 위에 exec 채널 열어 명령 실행:
  - `exec(handle, cmd) -> ExecOutput { exit_status, stdout, stderr }` (단발용 — `command -v rsync` detect)
  - `exec_streaming(handle, cmd, on_stdout_line) -> exit_status` (rsync stdout 라인 단위 콜백 + stderr 수집)
- `core/copy_progress.rs` — rsync `--info=progress2` 라인 파서.
- `services/progress_events.rs` — typed `ProgressEvent`.

### 기존 모듈 변경

- `core/ops.rs::copy_execute` — `decide()` 결과로 분기. SshSameHost 면 신규 `same_host_copy` 호출, 그 외는 기존 `copy_relay`.
- `services/connection_pool::ActiveConnection` — `rsync_available: Mutex<Option<bool>>` 필드 추가 (per-connection 캐시).
- `core/ops.rs::CopyPlan/MovePlan` — `strategy: CopyStrategy` 필드 추가 (UI 가 사용자에게 미리 표시).
- `commands/fs_ops` — 시그니처 변경 없음 (분기는 backend 내부).
- `lib.rs::make_specta_builder` — `collect_events!` 에 `ProgressEvent` 추가.

### Frontend 변경

- `hooks/useProgressEvents.ts` — `events.progressEvent.listen` 받아 store/context 에 progress 상태 전달.
- `components/dialogs/ProgressModal.tsx` — bar + bytes_done/total + speed + ETA 표시. progress 값 없으면 spinner 유지 (cp fallback 또는 rsync detect 전).
- `components/dialogs/ConfirmDialog` 사용처 (App.tsx CopyOrMovePlanBody): `plan.strategy` 한 줄 표시 — "same-host (fast, server-side)" / "relay (via this PC)" / "local".

---

## Same-host copy 흐름 (rsync 기준)

```
0. ConnectionPool 에서 active SSH session 가져옴 (이미 인증된 handle)
1. rsync detect (per-connection 캐시):
   exec("command -v rsync"), exit 0 면 rsync 사용 / 아니면 cp -a
2. SFTP 로 dst 충돌 감지 + .bak.<UTC ts> 로 rename
   (MVP-2 의 pick_backup_path 재사용)
3. exec 명령 구성 (path 는 single-quote escape):
   rsync -a --info=progress2 -- '<src>' '<dst>'
   또는
   cp -a -- '<src>' '<dst>'
4. exec_streaming: stdout 라인 받아 parse_rsync_progress2_line → ProgressEvent emit
   - 1초 throttle (IPC 폭주 방지)
   - cp 는 progress 없음 → emit 안 함 (spinner 유지)
5. exit 0: 성공. JournalEntry push (UndoCopy with backups_to_restore — 기존 schema 그대로).
6. exit !=0: DuetError::Ssh(stderr) — hard error, frontend toast.
```

### Path escaping

- single-quote 감싸기 + path 안 `'` 는 `'\''` 로 (POSIX shell 표준)
- path 안 `\0` 있으면 거부 (validation step)
- 별도 helper: `core/copy_strategy::shell_escape_path(p: &Path) -> Result<String, DuetError>`

### rsync detect 캐시

- `ActiveConnection.rsync_available: Mutex<Option<bool>>` 필드 추가 (default `None` = 미확인)
- 첫 SshSameHost copy 때 `command -v rsync` exec → 결과 cache
- 이후 같은 connection 의 모든 same-host copy 가 캐시 사용
- 사용자가 중간에 rsync 설치 → 캐시 stale (cp 계속 사용). 연결 재시작 시 reset. 우선순위 낮음.

### Different-host SSH↔SSH

- `decide()` 결과 `Relay` → 기존 `copy_relay` 사용 (변경 없음)
- read_full + write_full 로 본인 PC 통과 (이미 MVP-2 에 구현)

---

## IPC + 이벤트 surface

### CopyPlan / MovePlan 확장

```rust
#[derive(Serialize, Deserialize, Type)]
pub struct CopyPlan {
    // 기존 필드 (src_source, dst, items, conflicts, total_size_bytes)
    pub strategy: CopyStrategy,  // 신규
}

#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CopyStrategy {
    LocalToLocal,
    Relay,
    SshSameHost,
}

// MovePlan 도 동일하게 strategy 필드 추가.
// is_same_fs 는 유지 (rename optimization 용 — same fs면 atomic rename 가능).
```

### 신규 이벤트

```rust
#[derive(Serialize, Deserialize, Type, Event)]
pub struct ProgressEvent {
    /// copy_execute 진입 시 발급한 임시 UUID. JournalEntry.id 와 별개
    /// (op 진행 중에는 entry id 가 아직 없음 — push 는 op 완료 후).
    pub op_id: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub speed_bps: Option<u64>,
    pub eta_sec: Option<u32>,
    pub percent: Option<u8>,
}
```

emit timing:
- rsync stdout 라인이 progress 형식이면 emit
- 1초 throttle: 마지막 emit 시각 캐시, 그 안에 새 라인 와도 skip (마지막 100% 라인은 항상 emit)

### Frontend hook

```ts
export function useProgressEvents(): void {
  // events.progressEvent.listen → ui-dialogs progress state 갱신
  // ProgressModal 이 그 state 읽어서 bar/percent 표시
}
```

ui-dialogs store 에 `progress?: { bytes_done, bytes_total, speed_bps, eta_sec, percent }` 필드 추가. ProgressModal 이 close 될 때 (`open` → false) 자동 reset.

### ProgressModal 확장

- `progress` prop 또는 store 에서 읽음
- `progress == null` (cp fallback / rsync detect 전 / 시작 직후) → 기존 spinner
- `progress != null` → bar + `${formatSize(bytes_done)} / ${formatSize(bytes_total)} · ${formatSize(speed_bps)}/s · ETA ${eta_sec}s`

---

## Test strategy

### Backend 단위 테스트 (TDD)

- `core/copy_strategy::decide()` — 6 case
  - Local↔Local → LocalToLocal
  - Local↔Ssh → Relay
  - Ssh↔Local → Relay
  - Ssh↔Ssh same host_ip / 다른 user → SshSameHost
  - Ssh↔Ssh same host_ip / 같은 user → SshSameHost
  - Ssh↔Ssh different host_ip → Relay
- `core/copy_progress::parse_rsync_progress2_line()` — 8-10 sample line
  - 정상 line, 100% line, xfr#/ir-chk 잡음, 빈 줄, summary, 단위 변환
  - parser None 반환 = silent skip (robust)
- `core/copy_strategy::shell_escape_path()` — quote/escape 검증
- `ssh/remote_exec` — 시그니처 sanity (실제 exec 통합은 docker 후속)

### Smoke test 확장

`tests/mvp3_smoke.rs` (신규 또는 mvp2_smoke 확장):
- copy_strategy decide 매트릭스 (network 없음, fast)
- rsync progress parser 정확도 8-10 case
- shell escape edge cases

(실제 SSH↔SSH 통합 검증은 docker compose 후속 — MVP-3 범위 외)

### Frontend

- 기존 vitest 영향 없음 (ProgressModal 확장은 인터랙션 spot-check 1개)
- `useProgressEvents` 는 mock 안 함 — Tauri webview 통합

---

## 위험 영역

- **rsync 출력 형식 차이**: rsync 3.x `--info=progress2` 는 안정적이지만 BSD rsync / 매우 오래된 버전 차이 가능. parser None 반환 = silent skip (copy 는 진행, progress 만 안 보임) — robust.
- **path 안 special char**: single-quote / 백슬래시 / 줄바꿈. shell_escape_path 단위 테스트 강화.
- **rsync detect 캐시 stale**: 사용자가 중간에 rsync 설치 → 캐시 false 면 cp 계속. 연결 재시작 또는 명시 reset 으로 대응 — MVP-3 우선순위 낮음.
- **중간 취소**: cancel 미구현 (MVP-4 CancellationToken). ProgressModal 안에서 사용자가 닫기 시도 → 무시 (MVP-2 와 동일 modal lock).
- **큰 파일 stress (10GB+, 1만개 파일+)**: docker compose 환경 마련 후 별도 task. MVP-3 핵심 기능 검증과 분리.
- **rsync exit code 23 (partial)**: hard error 로 처리. UndoCopy 의 backups_to_restore 가 부분 복원할 수 있는지는 후속 검토.

---

## Phase 분할

- **Phase A — Foundation (parser + strategy + event)**
  - `core/copy_strategy.rs` + 단위 테스트
  - `core/copy_progress.rs` + 단위 테스트
  - `services/progress_events.rs` (typed event)
- **Phase B — Remote exec**
  - `ssh/remote_exec.rs` (`exec` + `exec_streaming`)
  - 시그니처 테스트
- **Phase C — copy_execute 분기 + same_host_copy**
  - `ActiveConnection.rsync_available` 필드 추가
  - `core/ops.rs::copy_execute` strategy 분기
  - `same_host_copy()` 함수: detect → backup rename → exec_streaming → progress emit → hard error mapping
  - `CopyPlan/MovePlan.strategy` 필드 추가, plan 함수에서 채움
- **Phase D — Frontend**
  - `services/progress_events` 등록 (`collect_events!` lib.rs)
  - `hooks/useProgressEvents` hook
  - `ProgressModal` 확장 (bar + speed/ETA)
  - `ConfirmDialog` body 에 strategy 1줄 (CopyOrMovePlanBody 수정)
  - bindings 자동 갱신
- **Phase E — Smoke + 마무리**
  - `tests/mvp3_smoke.rs` (또는 mvp2_smoke 확장)
  - ROADMAP MVP-3 [x]

---

## Open items / deferred

- **MVP-4**: TaskQueue + cancel + 동시 작업 제한. MVP-3 의 ProgressEvent 인프라가 그대로 활용됨.
- **큰 파일 / 다수 파일 stress test (docker)**: 별도 task. ROADMAP "10GB+, 1만개 파일+" 은 환경 + 재현성 요구.
- **rsync 출력 BSD/legacy 호환**: 필요 시 parser variant 추가.
- **연결 중간 rsync 설치 → 캐시 reset**: 명시 reset command 또는 자동 detect.
- **rsync exit 23 부분 복원**: `--partial` 옵션 + UndoCopy 부분 복원 로직.

---

## CLAUDE.md 규약 준수 체크

- §1 IPC 경계: copy_execute 는 backend command 통해서만, frontend 는 fs/SSH 직접 호출 X. ✅
- §2 백엔드 레이어: `commands → core/ops → ssh/remote_exec → russh`. core 가 ssh 사용 OK (한 단계 아래). ✅
- §3 영구삭제: 무관 (copy 만 다룸).
- §4 undo 가능: SshSameHost copy 도 UndoCopy 로 기록 (backup_to_restore 포함). ✅
- §5 자격증명: 무관 (이미 인증된 handle 사용).
- §6 의존성: 새 crate 없음 (rsync/cp 는 원격 binary). ✅
- §7 path: PathBuf + shell_escape_path 단계 강화. ✅
- §8 unsafe: 없음. ✅
- §9 시스템 ssh 호출 X: russh exec 채널만 — `std::process::Command::new("ssh")` X. ✅
- DON'T list "같은 호스트 SFTP 복사 시 본인 PC를 거쳐가기": Hard error 정책으로 silent relay 차단. ✅

---

## Spec self-review

- [x] Placeholder scan: TBD/TODO 없음
- [x] Internal consistency: Phase A-E 가 design 의 모듈/컴포넌트와 1:1
- [x] Scope check: 단일 plan 으로 처리 가능
- [x] Ambiguity check: rsync vs cp 우선순위, 진행률 throttle, 실패 정책 모두 명시
