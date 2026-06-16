# P0 안전 픽스 — 설계 (Spec)

> 코드 전체 리뷰(2026-06-16, 멀티에이전트 + 적대적 재검증)에서 확인된 **안전망 무결성·데이터손실·입력검증** 결함 중 우선순위 P0 항목을 고친다.
> duet 의 정체성은 "안전한 파일 매니저(휴지통 + undo)" 인데, 정상 경로는 견고하나 **실패/부분실패 경로에서 안전망이 새는** 결함이 집중돼 있어 이를 메운다.

## 배경 / 결정 기록

- 리뷰 데이터 원본: `/tmp/duet_review.json` (버그 91 / 약점 84 / 개선 105 / 규칙위반 19, 고위험 30건 적대적 재검증 — 29 confirmed).
- **키스톤(#5, 부분실패 저널 기록) 구현 방식 결정:**
  - **선택: Approach X (패턴매칭).** 코드베이스에 이미 있는 `apply_relay`(`core/ops.rs:1592`, *"실패/취소여도 부분 진행분을 journal 에 기록(§4)"*) 패턴을 `delete`/`copy`/`move` 에도 적용. 온디스크 포맷(`Push`/`MarkUndone`) **무변경**, 마이그레이션 없음.
  - 커버: Rust 에러 조기반환(`?`) — 네트워크·권한·dst 실패 등 실제로 흔함.
  - **미커버(의도적):** 프로세스 하드 크래시/정전 중간 (드묾). 이를 위한 온디스크 2단계 저널링(OpStart→Commit, "Approach Y")은 **P1 후속**으로 분리 — 별도 spec 필요(포맷 변경 + replay + 부팅 복구).
- **범위 밖(명시):** C4(symlink 복사 정책), C2(TaskQueue 워커 누수), C6(exec 취소 토큰), Y(크래시-안전 저널링). 전부 P1.

## 공통 규칙

- 항목당 **1 커밋** ("한 PR = 한 가지 변경"). 리팩토링/기능 섞지 않음.
- fs/core/services 변경은 **테스트 먼저(TDD)** — 테스트 없이 머지 금지(CLAUDE.md).
- `cargo fmt` + `cargo clippy -- -D warnings` 통과.
- 영구삭제/SSH/경로 규칙(§3/§5/§7/§9) 위반 없이.

## 구현 순서

저위험·고확실(1–4) → 키스톤(5) → 교차레이어(6–8).

---

### #1 — preview_stream 0바이트 Range 언더플로 패닉 (C5)

- **현재:** `services/preview_stream.rs:155` `let actual_end = start + bytes.len() as u64 - 1;`. 빈 파일(또는 `read_range` 가 0바이트 반환) 시 `0 + 0 - 1` → u64 언더플로 패닉. `:144` 가드 `total > 0 && start >= total` 는 `total==0` 일 때 단락평가로 통과시켜 빈 파일 Range 요청이 도달.
- **수정:** (a) `total == 0` 이면 Range 분기 진입 전 `200 OK + 빈 본문`(RFC 7233: 빈 리소스 Range 는 무시 가능). (b) 그 외에도 `bytes.is_empty()` 면 `actual_end` 산술을 우회하고 빈 본문으로 응답 — `start + len - 1` 언더플로를 구조적으로 제거.
- **테스트:** 빈 파일에 `Range: bytes=0-` 요청 → 패닉 없이 유효 응답(`#[tokio::test]`, `MockFs` 또는 tempfile 0바이트).
- **커밋:** `be/svc: preview_stream 0바이트 Range 언더플로 방어`

### #2 — move_within_host 가 모든 rename 실패를 EXDEV 로 단정 (C3)

- **현재:** `fs/ssh.rs:78` `if sftp.rename(from_s, to_s).await.is_ok() { return Ok(()); }` — `.is_ok()` 로 에러종류를 버리고, 실패면 무조건 `exec_cp` + `remove_recursive(from)` 폴백(`:81-83`). PermissionDenied/NotFound/dst-exists 도 cp+삭제로 진입.
- **완화 존재:** `exec_cp` 는 `?` 라 cp 실패 시 원본 보존(데이터 손실은 이미 방지됨). 따라서 **정확성/의미 결함**이지 즉시 손실은 아님.
- **수정:** rename 결과 에러를 검사해 **cross-device(EXDEV 상응) 일 때만** cp+remove 폴백. 그 외(Perm/NotFound/dst-exists) 는 그대로 전파. SFTP 에러→분류 매핑은 `russh_sftp` 의 StatusCode 확인 후 구현(추측 금지 — 구현 단계에서 실제 variant 확인).
- **테스트:** mock SFTP 에서 권한 실패 주입 → cp 폴백 안 타고 에러 전파 확인.
- **커밋:** `be/fs: move_within_host EXDEV 한정 폴백`

### #3 — stream_copy_file remove→rename 교체창 데이터 손실 (A5)

- **현재:** `fs/mod.rs:234-241`. `rename(part→dst)` 실패 + dst 존재 시 `remove(dst)`(영구삭제, `local.rs:103-114`) 후 다시 `rename(part→dst)`. 두 호출 사이 크래시/단절이면 기존 dst 소멸 + 신규 dst 부재 = **영구 손실 윈도우**. (SFTP rename 이 기존 파일 교체 못 하는 케이스 전용 경로.)
- **수정 — 백업 스왑:** `remove(dst)` 대신 `rename(dst → dst.duet-old)` → `rename(part → dst)` → `remove(dst.duet-old)`. 어느 순간에도 dst 또는 `dst.duet-old` 중 하나는 항상 존재. 마지막 remove 실패는 비치명(잔존 백업, 로그만).
- **주의:** dst 는 보통 호출자가 사전 백업한 충돌파일 또는 재시도된 자기 파일(코드 주석). trash 경유는 과함 — 백업 스왑이 적절.
- **테스트:** dst 가 이미 존재하는 상태에서 rename-replace 불가 mock → 스왑 후 dst 가 새 내용이고 백업 정리됨 확인. "스왑 중간 실패" 시 백업이 남아 복구 가능함 확인.
- **커밋:** `be/fs: stream_copy 교체창 데이터손실 제거 (백업 스왑)`

### #4 — undo 2단계 커밋: 실행 성공 후에만 undone 마킹 (A2)

- **현재:** `journal.rs:272-285` `pop_undoable` 이 undo 실행 *전에* 메모리+디스크(`MarkUndone`)로 `undone=true` 확정. 호출자 `commands/undo.rs:19,29` 가 그 후 `execute_undo` 실행 → 실패/부분성공해도 이미 "되돌림 완료" 로 마킹돼 재시도 불가.
- **수정:**
  - `journal.rs`: `pop_undoable` → **`peek_undoable()`**(가장 최근 `!undone` 을 마킹 없이 반환) + **`commit_undone(id)`**(메모리 set + `MarkUndone` append).
  - `commands/undo.rs`: `peek_undoable()` → `execute_undo()` → **outcome 이 성공 종류일 때만** `commit_undone(id)` + `JournalChangedEvent{change:"undone"}` emit. 실패 시 엔트리는 undoable 로 남아 재시도 가능(필요 시 별도 이벤트/토스트).
  - `UndoOutcome.kind`(`core/undo.rs`)의 성공/실패 variant 는 구현 단계에서 실제 enum 확인 후 분기.
- **테스트:** `execute_undo` 가 실패하는 시나리오에서 엔트리가 여전히 `peek_undoable` 로 잡히는지(재시도 가능) + 성공 시에만 디스크에 `MarkUndone` 기록되는지.
- **커밋:** `be/svc: undo 2단계 커밋 — 실행 성공 후 undone 마킹`

### #5 — 부분실패 저널 기록 (A1/A4) ★ 키스톤

- **현재:** `delete_execute`(`ops.rs:124-166`), `copy_execute_relay`(:236-344), `copy_execute_same_host`(:2607-2774), `move_execute`(:368-444) 가 항목 루프를 `?` 로 돌고 **전부 성공 후 단 한 번** `journal.push`. 중간 실패 시 1..N-1 항목은 이미 휴지통이동/복사/이동됐는데 journal 미기록 → **Ctrl+Z 복원 불가**. (A4: same-host copy 는 충돌 backup 후 copy 실패 시 .bak 고아 + UndoCopy 미기록.)
- **수정 — `apply_relay`(:1592) 템플릿 적용:**
  ```rust
  let mut items = Vec::new();                          // 누적 (TrashItem / 복사경로 / MoveItem / backups)
  let mut outcome: Result<(), DuetError> = Ok(());
  for t in &plan.targets {
      if cancel.is_cancelled() { outcome = Err(DuetError::Cancelled); break; }
      match fs.trash(&p, &batch).await {               // 또는 copy/move 단위 작업
          Ok(loc) => items.push(/* ... */),
          Err(e) => { outcome = Err(e); break; }
      }
  }
  let entry = ctx.journal.push(op, undo_with(items)).await?;  // ★ 부분분이라도 기록
  outcome?;                                                    // 그 다음 에러 전파
  Ok(entry)
  ```
  - 4개 함수 각각 누적 타입이 다름: delete=`Vec<TrashItem>`, copy=`UndoCopy{copied, backups_to_restore}`, move=`UndoMove{moved, backups_to_restore}`. 각자 누적 후 동일 패턴.
  - Permanent delete 는 undo 가 `Irreversible` 이므로 부분기록은 audit 성격(복원 불가) — push 는 하되 손실은 없음.
  - **same-host copy(A4):** backup rename 을 `backups_to_restore` 에 누적, copy 실패 시에도 push → Ctrl+Z 가 .bak 복원.
- **테스트(핵심):** `MockFs` 에 "N번째 항목에서 실패 주입" → `journal.history` 에 1..N-1 의 undo 정보가 남고, 그것으로 `execute_undo` 시 복원되는지. delete/copy/move 각각.
- **커밋:** `be/core: 파괴적 작업 부분실패 시에도 journal 기록 (§4)`

### #6 — archive 추출 zip-slip / 옵션-인젝션 가드 (B1)

- **현재:** `core/archive.rs:253-262` `remote_extract_command` 가 `unzip -o {a} -d {d}` / `tar -xf {a} -C {d}` 로 호스트 바이너리 exec. `shell_escape_path` 는 셸 메타문자만 막고 **아카이브 내부 엔트리 경로(`../`·절대경로)는 미검사** → dest 밖 호스트 임의경로 덮어쓰기. `--` 구분자도 없어 `-` 시작 경로가 옵션으로 해석될 여지.
- **수정 (우선순위순):**
  1. **추출 전 엔트리 검증(핵심):** host-side `unzip -l` / `tar -tf` 로 목록을 받아, 각 엔트리가 절대경로(`/` 시작)이거나 `..` 컴포넌트를 포함하면 **추출 거부**(`DuetError::NotPermitted` 류). 로컬 추출 경로의 zip `enclosed_name` 방어와 의미 일치시킴.
  2. **옵션-인젝션:** tar 에 `--no-absolute-filenames` 추가. 경로 인자가 항상 절대경로(SFTP canonicalize 결과)임을 전제하되, 방어적으로 `--`(tar) 적용 / unzip 은 `-d` 분리 유지 + 경로 정규화.
- **테스트:** `../` 또는 절대경로 엔트리를 가진 아카이브 목록(mock exec 출력)에 대해 거부되는지. 정상 아카이브는 통과.
- **커밋:** `be/core: archive 추출 zip-slip/옵션-인젝션 가드`

### #7 — 연결 close → reconnect 부활(resurrection) 차단 (C1)

- **현재:** `connection_supervisor.rs:83-173` `reconnect_loop` 이 sleep(최대 30s)+connect(수초 IO) 중일 때, 사용자가 `connection_close`(`commands/connection.rs`)로 `pool.remove(id)` 해도 **in-flight reconnect 에 취소 신호가 없음**. `:143 pool.insert(new_conn)` 가 close 여부 재확인 없이 무조건 실행 → 끊긴 연결이 되살아나고 Disconnected 직후 Connected 가 다시 emit.
- **수정 — id별 CancellationToken:**
  - `connection_pool.rs`: 풀에 `cancels: Mutex<HashMap<ConnectionId, CancellationToken>>`(또는 `ActiveConnection` 외부의 사이드맵) 추가. open 시 토큰 생성, **reconnect 는 같은 id 의 토큰 재사용**.
  - `commands/connection.rs` `connection_close`: `pool.remove` 와 함께 토큰 `cancel()` + 토큰 제거.
  - `connection_supervisor.rs`: sleep/connect 를 `tokio::select!`(토큰 cancelled vs 작업)으로 감싸 조기 중단, **그리고 `:143 insert` 직전 `token.is_cancelled()` 재확인** 시 즉시 `return`(부활 차단). 성공 후 새 supervisor spawn 시 토큰 승계.
- **테스트:** reconnect 가 connect 대기 중일 때 close → 토큰 cancel → insert 안 됨 + Connected 미emit. (mock connect 지연 주입.)
- **커밋:** `be/svc: 연결 close 시 in-flight 재연결 취소 — 부활 차단`

### #8 — 영구삭제 백엔드 확인 토큰 (A3)

- **현재:** `ops.rs:117-122` `delete_execute` 가 영구삭제 시 `permanent_delete_enabled` boolean 만 확인. README/§3 가 약속한 **"delete 단어 타이핑 확인"은 프론트엔드(`DangerConfirmDialog`)에만** 존재 — command 직접 호출 시 게이트 없이 비가역 삭제. (문서가 기술한 `Confirmed` 토큰은 코드에 미구현 = 문서-코드 드리프트.)
- **수정 — plan 발급 word 를 execute 가 검증:**
  - `delete_plan`(Permanent): confirm word = 고정 `"delete"`(현재 프론트 UX 와 일치, 프론트 변경 최소화) 를 `DeletePlan` 에 포함(`types`). 목적은 비밀유지가 아니라 "타이핑된 확인이 백엔드에 도달했음" 강제 — 랜덤화는 불필요(필요 시 후속).
  - `delete_execute`: `confirm_word: String` 인자 추가(IPC 시그니처 변경, `commands/fs_ops`) → plan 의 word 와 불일치 시 `DuetError::NotPermitted`.
  - `DangerConfirmDialog.tsx`: 사용자가 타이핑한 값을 execute 로 전달(현재 프론트 확인을 백엔드 강제로 승격). 비밀번호 아님 — 일반 텍스트.
  - **부수효과:** 문서-코드 드리프트(§문서동기화) 일부 해소.
- **테스트:** 잘못된 word → `NotPermitted`. 올바른 word + enabled → 통과. enabled=false → 기존대로 `NotPermitted`(word 무관).
- **커밋:** `be/cmd+fe: 영구삭제 확인 단어를 백엔드에서 검증 (§3)`

---

## 테스트 전략 요약

- 각 커밋은 **실패하는 테스트 먼저** → 구현 → green.
- fs/core 는 `MockFs`(기존) + 의도적 실패/지연 주입.
- 키스톤(#5)은 "N번째 실패 시 1..N-1 undo 보존" 을 delete/copy/move 각각 검증 — 이 spec 의 핵심 수용 기준.
- 회귀: `cargo test --manifest-path src-tauri/Cargo.toml` + `pnpm test`(#8 프론트) 전부 green.

## 수용 기준 (Definition of Done)

1. 8개 커밋, 각 1관심사, 각 테스트 동반.
2. 부분실패 시뮬레이션에서 undo 정보 보존(#5) — 신규 테스트로 입증.
3. 영구삭제가 백엔드 word 검증 없이는 불가(#8).
4. preview/move/stream/archive/connection 의 각 결함이 재현 테스트로 막힘.
5. `cargo clippy -- -D warnings`, `cargo fmt --check`, `pnpm lint` 통과.
6. 범위 밖 항목(C2/C4/C6/Y)은 손대지 않음 — 후속 spec 참조 주석만 허용.
