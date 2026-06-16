# P0 안전 픽스 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코드 리뷰에서 적대적 재검증된 P0 8건(안전망 무결성·데이터손실·입력검증)을 항목당 1커밋·TDD로 수정한다.

**Architecture:** 키스톤(#5)은 코드베이스에 이미 존재하는 `apply_relay`(`core/ops.rs:1592`) 패턴 — "결과 누적 → 루프 후 `journal.push` → `outcome?`" — 을 delete/copy/move 에 이식. 온디스크 저널 포맷 무변경. 나머지는 국소 결함 수정.

**Tech Stack:** Rust + Tauri 2 + tokio + russh/russh-sftp, 프론트(#8) React/TS. 테스트: `cargo test`(백), `vitest`(프), `MockFs`(테스트 모듈 로컬 정의 패턴).

**Spec:** `docs/specs/2026-06-16-p0-safety-fixes-design.md`

**공통 규칙:** 항목당 1커밋. fs/core/services 는 테스트 먼저. 각 커밋 전 `cargo fmt` + `cargo clippy -- -D warnings`. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**전 작업 공통 검증 명령:**
- 단일 테스트: `cargo test --manifest-path src-tauri/Cargo.toml <test_name> -- --nocolor`
- 린트: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- 포맷: `cargo fmt --manifest-path src-tauri/Cargo.toml`

---

## Task 1: preview_stream 0바이트 Range 언더플로 (C5)

**Files:**
- Modify/Test: `src-tauri/src/services/preview_stream.rs` (수정: ~134, ~143-155; 테스트: 같은 파일 `#[cfg(test)]`)

- [ ] **Step 1: 변경 지점 정독**

Read `src-tauri/src/services/preview_stream.rs:120-180`. 확인: `let total = meta.size.unwrap_or(0)`(134), 가드 `if total > 0 && start >= total`(144), `let actual_end = start + bytes.len() as u64 - 1`(155). 테스트 모듈이 있으면 mock 패턴 파악(없으면 핸들러를 직접 호출하는 단위테스트가 어려울 수 있음 — 아래 Step 2 참조).

- [ ] **Step 2: 실패 테스트 작성**

핸들러가 `Request`/`Response`(tauri http) 의존이라 직접 호출이 무거우면, 언더플로 산술만 분리해 순수 함수로 추출 후 테스트한다. `preview_stream.rs` 에 헬퍼 추가:

```rust
/// Range 응답의 content-range end 계산. 빈 바이트면 None(빈 본문 응답).
fn content_range_end(start: u64, n: usize) -> Option<u64> {
    if n == 0 { None } else { Some(start + n as u64 - 1) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_range_end_handles_empty() {
        assert_eq!(content_range_end(0, 0), None);   // 언더플로 없음
        assert_eq!(content_range_end(5, 0), None);
        assert_eq!(content_range_end(0, 10), Some(9));
        assert_eq!(content_range_end(100, 1), Some(100));
    }
}
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml content_range_end_handles_empty`
Expected: 컴파일 에러(함수 미정의) 또는 FAIL.

- [ ] **Step 4: 구현 — 핸들러를 헬퍼로 교체 + total==0 조기처리**

`:144` 가드를 `total == 0` 도 처리하도록 보강하고, `:155` 를 헬퍼로 교체:

```rust
// total==0(빈 파일): Range 무시, 200 OK 빈 본문 (RFC 7233 허용).
if total == 0 {
    return Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, "0")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .ok();
}
```
그리고 `:155` 영역:
```rust
let bytes = fs.read_range(&path, start, want).await.ok()?;
let actual_end = match content_range_end(start, bytes.len()) {
    Some(e) => e,
    None => start, // 빈 read — Content-Range 는 start-start, 본문 빔
};
```
(정확한 응답 형태는 기존 빌더 체인에 맞춰 조정. 핵심: `start + len - 1` 무방어 산술 제거.)

- [ ] **Step 5: 통과 확인 + 린트 + 커밋**

Run: `cargo test --manifest-path src-tauri/Cargo.toml content_range_end_handles_empty` → PASS
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` → 0 warnings
```bash
git add src-tauri/src/services/preview_stream.rs
git commit -m "$(printf 'be/svc: preview_stream 0바이트 Range 언더플로 방어\n\n빈 파일 Range 요청 시 start+len-1 u64 언더플로 패닉을 제거.\ntotal==0 은 200 빈 본문, 빈 read 는 content_range_end 헬퍼로 우회.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: move_within_host EXDEV 한정 폴백 (C3)

**Files:**
- Modify: `src-tauri/src/fs/ssh.rs:70-84` (`move_within_host`)
- Test: 같은 파일 `#[cfg(test)]` (또는 `tests/ssh_*` 중 단위 가능한 곳)

- [ ] **Step 1: SFTP 에러 종류 확인 (추측 금지)**

Read `src-tauri/src/fs/ssh.rs` 의 import + `russh_sftp` 에러 타입. 확인할 것: `sftp.rename(..)` 의 `Err` 가 어떤 타입인지(`russh_sftp::client::error::Error` 추정), cross-device/EXDEV 를 어떻게 표현하는지(StatusCode? errno?). `grep -rn "StatusCode\|SftpError\|client::error" src-tauri/src/fs/ssh.rs` 로 기존 에러 처리 선례 확인. **여기서 확인된 실제 variant 로 Step 3 코드를 작성.**

- [ ] **Step 2: 실패 테스트 작성**

`fs/ssh.rs` 테스트 모듈에, rename 결과를 분류하는 순수 헬퍼를 분리해 테스트(SFTP 세션 mock 은 무거우므로 분류 로직만 단위화):

```rust
/// rename 실패가 cross-device(cp 폴백 대상)인지 판정.
/// 그 외(권한/부재/dst존재)는 false → 에러 전파.
fn is_cross_device(err: &DuetError) -> bool {
    // Step 1 에서 확인한 실제 표현으로 구현. 예: 메시지에 "cross-device"/EXDEV,
    // 또는 SFTP StatusCode::Failure 등. 보수적으로: 명확히 EXDEV 일 때만 true.
    matches!(err, DuetError::Io(m) if m.contains("cross-device") || m.contains("EXDEV"))
}

#[cfg(test)]
mod move_fallback_tests {
    use super::*;
    #[test]
    fn only_exdev_triggers_cp_fallback() {
        assert!(is_cross_device(&DuetError::Io("cross-device link".into())));
        assert!(!is_cross_device(&DuetError::PermissionDenied("x".into())));
        assert!(!is_cross_device(&DuetError::NotFound("x".into())));
    }
}
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml only_exdev_triggers_cp_fallback`
Expected: 컴파일 에러/FAIL.

- [ ] **Step 4: 구현 — `.is_ok()` 를 에러분류로 교체**

`move_within_host`(:78):
```rust
match sftp.rename(from_s, to_s).await {
    Ok(()) => return Ok(()),
    Err(e) => {
        let mapped = /* Step1 에서 확인한 변환: SftpError -> DuetError */;
        if !is_cross_device(&mapped) {
            return Err(mapped); // Perm/NotFound/dst-exists 는 cp+삭제 안 함
        }
        // cross-device 확정 시에만 cp -a 후 원본 제거
    }
}
self.exec_cp(from, to).await?;
Box::pin(remove_recursive(sftp, from)).await
```
주석(:81) 도 "EXDEV 확정 시에만" 으로 수정.

- [ ] **Step 5: 통과 + 린트 + 커밋**

Run: `cargo test --manifest-path src-tauri/Cargo.toml only_exdev_triggers_cp_fallback` → PASS
Run: clippy → 0
```bash
git add src-tauri/src/fs/ssh.rs
git commit -m "$(printf 'be/fs: move_within_host EXDEV 한정 폴백\n\nrename 실패를 .is_ok() 로 뭉개지 않고 cross-device 일 때만 cp+remove.\n권한/부재/dst존재는 그대로 전파 — 잘못된 원본 삭제 차단.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: stream_copy_file 교체창 데이터손실 제거 (A5)

**Files:**
- Modify: `src-tauri/src/fs/mod.rs:234-242` (`stream_copy_file` 의 rename 분기)
- Test: `src-tauri/src/fs/mod.rs` `#[cfg(test)]` — 로컬 `MockFs` 정의(또는 tempfile + LocalFs)

- [ ] **Step 1: 정독 + 테스트 인프라 확인**

Read `src-tauri/src/fs/mod.rs:170-243` 및 같은 파일 하단의 `#[cfg(test)]`(있으면 mock 패턴 확인). `compare.rs:686` 의 `struct MockFs` 를 참고 모델로 본다. LocalFs + tempfile 로도 테스트 가능한지 판단(권장: rename 교체불가 상황은 SFTP 전용이므로, 의미 검증은 "백업 스왑 순서" 단위로).

- [ ] **Step 2: 실패 테스트 — 백업 스왑 순서**

rename 교체 불가 + dst 존재 상황을 흉내내는 mock 으로 "remove(dst) 직접 호출이 일어나지 않고 dst.duet-old 백업 스왑 경로를 탄다"를 검증. 호출 시퀀스를 기록하는 mock:

```rust
// 테스트 모듈에 swap 헬퍼를 분리(아래 구현에서 추출):
//   async fn finalize_part(dst_fs, part, dst) -> Result<(),_>
// 그리고 mock 이 rename(part->dst) 첫 시도 실패(dst존재) → 스왑 경로 기록.
#[tokio::test]
async fn finalize_uses_backup_swap_not_destructive_remove() {
    // RecordingFs: rename/remove/metadata 호출을 Vec<String> 으로 기록.
    // 시나리오: rename(part,dst) Err + metadata(dst) Ok
    //   기대 호출: rename(dst, dst.duet-old) → rename(part, dst) → remove(dst.duet-old)
    //   금지: dst 가 백업 없이 remove 되는 일.
    // (RecordingFs 는 이 테스트 모듈 로컬 struct — FileSystem 의 필요한 메서드만 구현,
    //  나머지는 unimplemented!())
}
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml finalize_uses_backup_swap_not_destructive_remove`
Expected: FAIL(현재는 destructive remove 경로).

- [ ] **Step 4: 구현 — 백업 스왑**

`:234-241` 교체:
```rust
// 완성 — .part 를 최종 이름으로. rename 이 기존 dst 를 교체 못 하면(SFTP),
// dst 를 백업으로 비켜둔 뒤 교체하고 백업 제거 — 어느 순간에도 dst 또는 백업이 존재.
if let Err(e) = dst_fs.rename(&part, dst).await {
    if dst_fs.metadata(dst).await.is_ok() {
        let backup = {
            let mut s = dst.as_os_str().to_os_string();
            s.push(".duet-old");
            std::path::PathBuf::from(s)
        };
        dst_fs.rename(dst, &backup).await?;        // dst → 백업 (원본 보존)
        dst_fs.rename(&part, dst).await?;          // part → dst
        let _ = dst_fs.remove(&backup).await;      // 백업 정리(실패는 비치명)
    } else {
        return Err(e);
    }
}
Ok(())
```
(가능하면 이 블록을 `async fn finalize_part(...)` 로 추출해 Step 2 테스트가 직접 호출.)

- [ ] **Step 5: 통과 + 린트 + 커밋**

Run: 위 테스트 PASS, clippy 0.
```bash
git add src-tauri/src/fs/mod.rs
git commit -m "$(printf 'be/fs: stream_copy 교체창 데이터손실 제거 (백업 스왑)\n\nrename 교체불가 시 remove(dst) 영구삭제 대신 dst->.duet-old 백업 스왑.\n크래시가 나도 dst 또는 백업 중 하나는 항상 존재.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: undo 2단계 커밋 (A2)

**Files:**
- Modify: `src-tauri/src/services/journal.rs:272-285` (`pop_undoable` → `peek_undoable` + `commit_undone`)
- Modify: `src-tauri/src/commands/undo.rs:19-35` (`undo_last`)
- Test: `journal.rs` `#[cfg(test)]` (기존 `pop_undoable_walks_stack` 갱신/추가)

- [ ] **Step 1: 실패 테스트 — peek 은 마킹 안 함, commit 만 마킹**

`journal.rs` 테스트 모듈에 추가:
```rust
#[tokio::test]
async fn peek_does_not_mark_until_commit() {
    let dir = tempdir().unwrap();
    let j = Journal::load_from(&dir.path().join("j.jsonl")).await.unwrap();
    let a = j.push(mk_op(), mk_undo()).await.unwrap();
    // peek 두 번 = 같은 엔트리(아직 안 지움)
    assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
    assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
    // commit 후엔 더 없음
    j.commit_undone(a.id).await.unwrap();
    assert!(j.peek_undoable().await.unwrap().is_none());
}
```
그리고 기존 `pop_undoable_walks_stack` 을 `peek`+`commit` 조합으로 갱신(또는 `pop_undoable` 을 `peek`+`commit` 래퍼로 유지하되 신규 API 추가).

- [ ] **Step 2: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml peek_does_not_mark_until_commit`
Expected: 컴파일 에러(`peek_undoable`/`commit_undone` 미정의).

- [ ] **Step 3: 구현 — journal.rs**

`pop_undoable`(:272) 을 둘로 분리:
```rust
/// 가장 최근 undone==false 엔트리를 반환(마킹 안 함). undo 실행 전 조회용.
pub async fn peek_undoable(&self) -> Result<Option<JournalEntry>, DuetError> {
    let lock = self.inner.lock().await;
    Ok(lock.iter().rposition(|e| !e.undone).map(|i| lock[i].clone()))
}

/// undo 실행 성공 후 호출 — 메모리+디스크에 undone 확정.
pub async fn commit_undone(&self, id: JournalId) -> Result<(), DuetError> {
    {
        let mut lock = self.inner.lock().await;
        if let Some(e) = lock.iter_mut().find(|e| e.id == id) {
            if e.undone { return Ok(()); } // 멱등
            e.undone = true;
        } else {
            return Ok(()); // 캐시에서 밀려난 오래된 엔트리 — no-op
        }
    }
    self.append(JsonlRecord::MarkUndone { id }).await
}
```
(`pop_undoable` 은 제거하거나, 다른 호출처가 있으면 `peek`+`commit` 으로 재구현.)

- [ ] **Step 4: 구현 — commands/undo.rs**

`undo_last`(:19-35):
```rust
let entry = match journal.peek_undoable().await? {
    Some(e) => e,
    None => return Ok(UndoOutcome {
        kind: UndoKind::Skipped,
        message: Some("Nothing to undo".into()),
        refreshed_locations: vec![],
    }),
};
let outcome = execute_undo(&entry, pool.inner()).await;
// 성공(Ok) 또는 비가역(Irreversible=재시도 무의미)일 때만 확정. Error 는 재시도 가능하게 남김.
if matches!(outcome.kind, UndoKind::Ok | UndoKind::Irreversible) {
    journal.commit_undone(entry.id).await?;
    let _ = JournalChangedEvent { entry, change: "undone".into() }.emit(&app);
}
Ok(outcome)
```
(`UndoKind` = `{Ok, Skipped, Irreversible, Error}` 확인됨 — `core/undo.rs:23`.)

- [ ] **Step 5: 통과 + 린트 + 커밋**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib journal` → 전부 PASS (기존 테스트 포함). clippy 0.
```bash
git add src-tauri/src/services/journal.rs src-tauri/src/commands/undo.rs
git commit -m "$(printf 'be/svc: undo 2단계 커밋 — 실행 성공 후 undone 마킹\n\npop_undoable 을 peek_undoable + commit_undone 으로 분리. execute_undo 가\nOk/Irreversible 일 때만 commit. Error 시 엔트리가 남아 재시도 가능.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: 부분실패 저널 기록 (A1/A4) ★ 키스톤

**Files:**
- Modify: `src-tauri/src/core/ops.rs` — `delete_execute`(:112-167), `copy_execute_relay`(:236-344), `move_execute`(:368-444), `copy_execute_same_host`(:2607-2774)
- Test: `ops.rs` `#[cfg(test)]` (기존 `apply_compare_*_then_undo`(:3206) 스타일 미러)

- [ ] **Step 1: 패턴 + 테스트 인프라 정독**

Read `core/ops.rs:1592-1628`(`apply_relay` 정본 패턴), `:3008-3080` 및 `:3206-3300`(기존 undo 테스트가 fs/OpCtx 를 어떻게 만드는지 — mock 구성, `OpCtx` 필드, journal 주입 방식). 이 테스트들이 쓰는 mock 을 #5 테스트의 모델로 삼는다.

- [ ] **Step 2: 실패 테스트 — delete 부분실패가 1..N-1 을 저널에 남김**

`ops.rs` 테스트 모듈에 "3개 중 2번째에서 trash 실패" mock 으로:
```rust
#[tokio::test]
async fn delete_partial_failure_journals_completed_items() {
    // FailingTrashFs: trash 를 호출 카운트로 추적, 2번째 호출에서 Err 반환.
    //   (compare.rs:686 MockFs / 기존 ops 테스트 mock 패턴을 따라 로컬 정의.)
    // OpCtx 는 기존 테스트와 동일하게 구성(임시 journal 포함).
    // 3개 target Trash 실행 → Err 기대.
    let err = delete_execute(&fs, plan_with_3_targets(), &ctx).await;
    assert!(err.is_err());
    // 핵심: journal 에 1건(첫 항목만 들어간 RestoreFromTrash)이 남아야 함.
    let hist = ctx.journal.history(10).await;
    assert_eq!(hist.len(), 1, "부분 진행분이 journal 에 기록되어야 함");
    match &hist[0].undo {
        UndoAction::RestoreFromTrash { items, .. } => assert_eq!(items.len(), 1),
        _ => panic!("expected RestoreFromTrash"),
    }
}
```
(copy/move 용 유사 테스트도 추가: `copy_partial_failure_journals_completed_items`, `move_partial_failure_journals_completed_items`.)

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml delete_partial_failure_journals_completed_items`
Expected: FAIL — 현재 `?` 조기반환이라 `history.len()==0`.

- [ ] **Step 4: 구현 — delete_execute 를 apply_relay 패턴으로**

`delete_execute`(:124-166) Trash 분기:
```rust
DeleteMode::Trash => {
    let batch_id = crate::services::trash::new_batch_id();
    let mut items = Vec::new();
    let mut outcome: Result<(), DuetError> = Ok(());
    for t in &plan.targets {
        let p = t.location.path.join(&t.name);
        match fs.trash(&p, &batch_id).await {
            Ok(loc) => {
                let trash_path = match &loc {
                    TrashLocation::Local { trash_id } => trash_id.clone(),
                    TrashLocation::Remote { trash_path } => trash_path.to_string_lossy().into_owned(),
                };
                items.push(TrashItem { trash_path, original_path: p });
            }
            Err(e) => { outcome = Err(e); break; }
        }
    }
    let op = OpKind::Trash { count: items.len() as u32, location: plan.source_location.clone() };
    let undo = UndoAction::RestoreFromTrash { source: plan.source.clone(), items };
    let entry = ctx.journal.push(op, undo).await?;  // ★ 부분분이라도 기록
    outcome?;                                        // 그 다음 에러 전파
    return Ok(entry);
}
```
Permanent 분기도 동일 구조(단 undo=`Irreversible`, push 는 audit 성격). **주의:** `op` 의 `count` 를 `plan.total_count` 가 아니라 실제 처리한 `items.len()` 로 (부분 반영). 함수 끝의 기존 단일 `ctx.journal.push`(:166) 는 제거(각 분기가 push+return 하도록 재구성).

- [ ] **Step 5: copy_execute_relay / move_execute / copy_execute_same_host 동일 적용**

각 함수의 항목 루프를 같은 패턴으로 변환:
- **copy_execute_relay**(:236-344): 복사 성공 경로를 `copied: Vec<PathBuf>` + 백업 rename 을 `backups_to_restore: Vec<BackupRestore>` 에 누적, 루프 후 `UndoCopy{...}` push → `outcome?`.
- **move_execute**(:368-444): `moved: Vec<MoveItem>` + 백업 누적, `UndoMove{...}` push → `outcome?`.
- **copy_execute_same_host**(:2607-2774): **A4 핵심** — backup rename 을 누적(`backups_to_restore`), copy 실패 시에도 `UndoCopy{copied, backups_to_restore}` push 후 `outcome?` → Ctrl+Z 가 .bak 복원.
각 함수 끝의 단일 `journal.push`(:344/:444/:2774) 는 누적-push 로 대체.

- [ ] **Step 6: 전체 통과 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib ops` → delete/copy/move 부분실패 테스트 + 기존 ops 테스트 전부 PASS.
Run: clippy 0.

- [ ] **Step 7: 커밋**

```bash
git add src-tauri/src/core/ops.rs
git commit -m "$(printf 'be/core: 파괴적 작업 부분실패 시에도 journal 기록 (§4)\n\ndelete/copy/move 를 apply_relay 패턴(누적->push->outcome?)으로 전환.\n중간 실패 시 1..N-1 항목의 undo 정보가 보존돼 Ctrl+Z 복원 가능.\nsame-host copy 는 .bak 백업도 누적해 실패 시 복원(A4).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: archive 추출 zip-slip/옵션-인젝션 가드 (B1)

**Files:**
- Modify: `src-tauri/src/core/archive.rs` (`remote_extract_command` 주변 + 호출처)
- Test: `archive.rs` `#[cfg(test)]`

- [ ] **Step 1: 정독**

Read `core/archive.rs:200-290`(remote_extract_command, run_host_command 및 호출처). 로컬 추출의 `enclosed_name` zip-slip 방어 위치도 확인(`grep -n "enclosed_name" src-tauri/src/core/archive.rs`)해 의미를 일치시킨다. host-side 목록 명령 출력 형식(`unzip -l`, `tar -tf`)을 어떻게 파싱할지 결정.

- [ ] **Step 2: 실패 테스트 — 엔트리 경로 검증**

엔트리 경로 검증을 순수 함수로 분리:
```rust
/// 아카이브 엔트리가 dest 밖으로 탈출하는지(절대경로 또는 .. 포함).
fn entry_escapes(entry: &str) -> bool {
    let p = std::path::Path::new(entry);
    p.is_absolute()
        || entry.starts_with('/')
        || p.components().any(|c| matches!(c, std::path::Component::ParentDir))
}

#[cfg(test)]
mod zipslip_tests {
    use super::*;
    #[test]
    fn rejects_traversal_entries() {
        assert!(entry_escapes("../evil"));
        assert!(entry_escapes("/etc/passwd"));
        assert!(entry_escapes("a/../../b"));
        assert!(!entry_escapes("safe/dir/file.txt"));
        assert!(!entry_escapes("file.txt"));
    }
}
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml rejects_traversal_entries`
Expected: 컴파일 에러/FAIL.

- [ ] **Step 4: 구현 — 추출 전 목록 검증 + 옵션 가드**

원격 추출 흐름(호출처)에 추출 *전* 단계 추가:
1. host-side 목록 명령 실행: zip→`unzip -Z1 {a}` (또는 `-l` 파싱), tar→`tar -tzf {a}`/`tar -tf {a}`.
2. 각 엔트리에 `entry_escapes` 적용 → 하나라도 true 면 `Err(DuetError::NotPermitted)` 로 추출 거부(메시지: "archive contains path-traversal entry").
3. `remote_extract_command` 의 tar 에 `--no-absolute-filenames` 추가:
   - `tar -xf --no-absolute-filenames {a} -C {d}` (GNU tar; 옵션 위치는 operand 앞).
4. (옵션-인젝션) 경로 인자가 절대경로(SFTP canonicalize 결과)임을 호출처에서 보장하거나, `-`-시작 방어로 dest 를 `./`-정규화. unzip 은 `--` 미지원이므로 목록검증을 1차 방어로 의존.

정확한 목록 파싱/명령은 Step 1 에서 확인한 형식으로 구현.

- [ ] **Step 5: 통과 + 린트 + 커밋**

Run: 테스트 PASS, clippy 0.
```bash
git add src-tauri/src/core/archive.rs
git commit -m "$(printf 'be/core: archive 추출 zip-slip/옵션-인젝션 가드\n\n원격 tar/unzip 추출 전 엔트리 목록을 검사해 절대경로/.. 엔트리를 거부.\ntar 에 --no-absolute-filenames. dest 밖 호스트 임의경로 덮어쓰기 차단.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: 연결 close → reconnect 부활 차단 (C1)

**Files:**
- Modify: `src-tauri/src/services/connection_pool.rs` (id별 CancellationToken 맵 추가)
- Modify: `src-tauri/src/services/connection_supervisor.rs:83-173` (`reconnect_loop` 가 토큰 확인)
- Modify: `src-tauri/src/commands/connection.rs` (`connection_close` 가 cancel)
- Test: `connection_supervisor.rs` 또는 `connection_pool.rs` `#[cfg(test)]`

- [ ] **Step 1: 정독**

Read `connection_pool.rs` 전체(구조체 필드, `insert`/`get`/`remove` 시그니처), `commands/connection.rs` 의 `connection_close`(앞서 본 reap→remove 흐름), `connection_supervisor.rs:83-173`. 토큰 저장 위치 결정: 풀에 `cancels: Mutex<HashMap<ConnectionId, CancellationToken>>` 추가가 가장 단순.

- [ ] **Step 2: 실패 테스트 — cancel 후 insert 차단**

토큰 로직을 풀 메서드로 노출하고 단위 테스트:
```rust
#[tokio::test]
async fn cancelled_connection_blocks_reinsert() {
    let pool = ConnectionPool::new();
    let id = /* 임의 ConnectionId */;
    let tok = pool.cancel_token_for(&id).await; // 없으면 생성/반환
    pool.cancel(&id).await;                     // connection_close 가 호출
    assert!(tok.is_cancelled());
    // reconnect 가드: is_cancelled 면 insert 안 함 (헬퍼로 표현)
    assert!(pool.is_cancelled(&id).await);
}
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cancelled_connection_blocks_reinsert`
Expected: 컴파일 에러(미정의 메서드).

- [ ] **Step 4: 구현 — pool 토큰 맵**

`connection_pool.rs`:
- 필드 추가: `cancels: tokio::sync::Mutex<std::collections::HashMap<ConnectionId, tokio_util::sync::CancellationToken>>`.
- `cancel_token_for(&self, id) -> CancellationToken`: 없으면 새로 만들어 저장 후 clone 반환(open/reconnect 가 같은 토큰 공유).
- `cancel(&self, id)`: 토큰 `.cancel()` 호출.
- `is_cancelled(&self, id) -> bool`.
- `remove(id)` 시 토큰도 정리(단, close 흐름은 cancel→remove 순서로 토큰을 먼저 cancel).

- [ ] **Step 5: 구현 — supervisor + close 배선**

`connection_supervisor.rs reconnect_loop`:
- 루프 시작 시 `let token = pool.cancel_token_for(&id).await;`
- `tokio::time::sleep(*delay)` 와 `connect(..)` 를 `tokio::select!` 로 `token.cancelled()` 와 race → 취소 시 `return`.
- **`:143 pool.insert(new_conn)` 직전:** `if token.is_cancelled() { /* 새 세션 정리 */ return; }`.
- 성공 후 `spawn_supervisor` 재호출은 같은 id → 같은 토큰 자동 공유.

`commands/connection.rs connection_close`: `pool.remove(&id)` 전에 `pool.cancel(&id).await` 추가.

- [ ] **Step 6: 통과 + 린트 + 커밋**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cancelled_connection_blocks_reinsert` → PASS, 기존 connection 테스트 회귀 없음, clippy 0.
```bash
git add src-tauri/src/services/connection_pool.rs src-tauri/src/services/connection_supervisor.rs src-tauri/src/commands/connection.rs
git commit -m "$(printf 'be/svc: 연결 close 시 in-flight 재연결 취소 — 부활 차단\n\n풀에 id별 CancellationToken 추가. close 가 cancel, reconnect_loop 가\nsleep/connect 를 select 로 중단하고 insert 직전 재확인. 종료한 연결의\n부활(Connected 재emit) 방지.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: 영구삭제 백엔드 확인 토큰 (A3)

**Files:**
- Modify: `src-tauri/src/core/ops.rs` (`delete_execute` 검증, `DeletePlan` 은 ops.rs:29)
- Modify: `src-tauri/src/commands/fs_ops.rs:82` (`fs_delete_execute` 시그니처)
- Modify: `src/components/dialogs/DangerConfirmDialog.tsx` + 호출처(타이핑값 전달)
- Modify: `src/types/bindings.ts` (tauri-specta 재생성 — devmode 자동) 
- Test: `ops.rs` `#[cfg(test)]` + (선택) 프론트

- [ ] **Step 1: 정독**

Read `commands/fs_ops.rs:67-110`(`fs_delete_plan`/`fs_delete_execute` 전체 시그니처와 인자), `src/components/dialogs/DangerConfirmDialog.tsx` 전체(`requiredWord` prop, `onConfirm`), 그리고 `DangerConfirm` 호출처(`grep -rn "DangerConfirm" src/`)에서 영구삭제 흐름과 타이핑값이 어디 있는지.

- [ ] **Step 2: 실패 테스트 — 잘못된 word 거부**

```rust
#[tokio::test]
async fn permanent_delete_requires_confirm_word() {
    // permanent_delete_enabled=true 인 settings 로 ctx 구성.
    let plan = DeletePlan { mode: DeleteMode::Permanent, /* ... */ };
    // 틀린 word
    let bad = delete_execute(&fs, plan.clone(), &ctx, "wrong".into()).await;
    assert!(matches!(bad, Err(DuetError::NotPermitted)));
    // 맞는 word
    let ok = delete_execute(&fs, plan, &ctx, "delete".into()).await;
    assert!(ok.is_ok());
}
```
(시그니처에 `confirm_word: String` 추가를 전제 — Step 3.)

- [ ] **Step 3: 실패 확인**

Run: `cargo test --manifest-path src-tauri/Cargo.toml permanent_delete_requires_confirm_word`
Expected: 컴파일 에러(인자 없음).

- [ ] **Step 4: 구현 — 백엔드 검증**

`delete_execute`(:112) 시그니처에 `confirm_word: String` 추가, 영구삭제 게이트(:117-122) 보강:
```rust
if matches!(plan.mode, DeleteMode::Permanent) {
    let s = ctx.settings.get().await;
    if !s.permanent_delete_enabled { return Err(DuetError::NotPermitted); }
    if confirm_word != "delete" { return Err(DuetError::NotPermitted); }
}
```
`commands/fs_ops.rs:82 fs_delete_execute` 에 `confirm_word: String` 인자 추가해 그대로 전달. (Trash 모드는 word 무시.)

- [ ] **Step 5: 구현 — 프론트 배선**

`DangerConfirmDialog` 호출처(영구삭제)에서 사용자가 타이핑해 활성화된 그 값을 `fs_delete_execute` 의 `confirmWord` 인자로 전달. `onConfirm` 이 타이핑값에 접근 가능하도록(이미 `requiredWord` 와 비교 중이므로 입력 state 를 onConfirm 으로 넘기거나 store 경유). devmode 면 `bindings.ts` 자동 재생성 — 아니면 `cargo run --bin export_bindings` 류로 갱신(확인).

- [ ] **Step 6: 통과 + 린트 + 커밋**

Run: `cargo test --manifest-path src-tauri/Cargo.toml permanent_delete_requires_confirm_word` → PASS, clippy 0.
Run: `pnpm lint` (프론트 변경) → 통과.
```bash
git add src-tauri/src/core/ops.rs src-tauri/src/commands/fs_ops.rs src/components/dialogs/DangerConfirmDialog.tsx src/types/bindings.ts
git commit -m "$(printf 'be/cmd+fe: 영구삭제 확인 단어를 백엔드에서 검증 (§3)\n\nfs_delete_execute 에 confirm_word 인자 추가. 영구삭제는 백엔드가 word 를\n검증 — 프론트-전용 게이트를 백엔드 강제로 승격. 문서-코드 드리프트 일부 해소.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review (작성자 체크)

- **스펙 커버리지:** spec #1–#8 ↔ Task 1–8 1:1 매핑 완료. 수용기준의 "부분실패 1..N-1 보존"은 Task 5 Step 2 테스트로, "백엔드 word 검증"은 Task 8 Step 2 로 커버.
- **범위 밖 준수:** C2/C4/C6/Y 미포함 확인.
- **타입 일관성:** `UndoKind{Ok,Skipped,Irreversible,Error}`, `DeletePlan` 필드, `FileSystem::trash/rename/remove/metadata` 시그니처, `apply_relay` 패턴 — 전부 실제 코드와 대조 확인.
- **알려진 검증 포인트(추측 금지):** Task 2 의 SFTP 에러 variant, Task 5/8 의 ops 테스트 mock 구성, Task 8 의 `fs_delete_execute` 정확한 인자/프론트 호출처 — 각 Task Step 1 에서 실제 코드 확인 후 코딩하도록 명시(플레이스홀더가 아니라 의도적 read-first 단계).

## 실행 순서 의존성

Task 1–8 은 서로 독립(다른 파일/함수). 순서는 위험도 오름차순 권장이나 병렬 가능. 단 Task 4(journal API)와 Task 5(ops push)는 같은 저널을 쓰므로 4 → 5 순서 권장(peek/commit 도입 후 ops 변경).
