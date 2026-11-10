# SYNC round 2 — independent review

Reviewer: ux-sync-sol. Date: 2026-11-11. Round **2 of at most 3**. Worktree `/private/tmp/duet-ux-smoke-worktrees/sync-sol`; branch `ux-smoke/sync-sol`; reviewer HEAD remains base `76b9b6e8b61608168b42a135a7a888422a3b1c60`.

**Overall verdict: APPROVE for the agreed round-2 scope; Rust validation remains static, cargo pending.** No new blocking defect found. R1-01 is closed by a passing independent-regression port. The lead explicitly accepts SC-01 as **LOCAL-only**; same-host partial-failure recovery stays **OPEN in backlog**, so R1-02 is dispositioned by scope and is not claimed fixed.

Reviewed target: `912bf01ab1d8c0c2054b6fca98d9e139d0b57f26`. Read all four new commits with `git show`; read Opus's `REVIEW-sync-round1.md` Round 2 section as implementation context, then checked actual code/tests. Own test/check results below are independent of Opus's reported results. File:line references refer to the temporarily applied target snapshot, now restored out of this worktree.

## Per-commit verdicts

| Commit | Verdict | Review evidence |
| --- | --- | --- |
| `d165503` — SC-11 edited-field prefill guard | **APPROVE** | `src/components/dialogs/CompareRulesBar.tsx:31-44` checks separate touched refs when settings resolves; change handlers set those refs synchronously (`:70-72`, `:82-85`). A user-selected exact 0 and edited ignore text survive late settings, while untouched fields still prefill. Persistence still writes tolerance only after explicit selection (`:60`). **Mocked-FE-test reproduced**: combined edit, recompare payload, persistence, and partial-touch cases all pass. |
| `6083f1a` — reviewer regression port + ignore-only case | **APPROVE** | `src/components/dialogs/CompareDialog.test.tsx:281-304` retains the exact R1 adverse sequence as a normal test, plus the case that edits only ignore text and expects untouched tolerance to become saved 60000. The port tests behavior rather than bypassing prefill; both pass. The original isolated reviewer patch remains in `_report/sc11-review-test.patch` as historical evidence and need not be reapplied over this port. |
| `b16b507` — conservative failed-new-file bookkeeping | **APPROVE, static Rust** | `src-tauri/src/core/ops.rs:1467` retains a failed new output unless lstat definitively returns NotFound. Permission/I/O/connection uncertainty no longer discards a potentially partial output; created/source arrays remain paired. `mirror_file_tests::new_file_copy_failure_with_uncertain_stat_is_recorded` injects partial creation, copy failure and denied lstat in a TempDir-backed mock. Reviewed test and code; **not compiled/executed here**. This test exercises the helper, not support for real cross-host Sync. |
| `912bf01` — consistent Sync strategy validation | **APPROVE, static Rust** | `core/ops.rs:1202` centralizes the existing supported combinations/error text. Execute derives current strategy (`:1252-1257`) and rejects unsupported/mismatched plans before mirror/prune; existing same-host endpoint validation remains. Preview checks support before traversal (`:1797-1798`). A forged Relay or LocalToLocal flag cannot make an actual local↔SSH pair reach the local mirror. Known endpoint mismatch remains relay/rejected; true same-host stays host-side. Guard tests use an untouchable mock and assert no journal; `ops_paths_tests.rs` now expects unsupported relay preview. **Not compiled/executed here**. |

## Re-verdicts for round-1 changes

- **`863d38d` (SC-11), with `d165503`/`6083f1a`: APPROVE.** The earlier blocking late-prefill defect is fixed: the original expected-0/received-2000 sequence is now a passing normal test. Initial SSH tolerance remains at least 2000ms, either source can be SSH, local-only keeps saved default, and explicit 0 within the dialog is honored/persisted. Larger saved tolerance and settings-failure paths retain existing passing coverage. This does not promise preservation of a saved 0 on a fresh remote open: the documented policy still floors that initial remote tolerance.
- **`a3a271c` + `b16b507` (SC-01 LOCAL-only): APPROVE on static review, Rust gate pending.** Local mirror/prune failure is retained as an outcome, prior mutations are finalized to journal before that outcome is returned, and failure/cancel with no recorded changes exits without an empty record. Created directories and completed trash moves count as mutations. A failed overwrite restores its backup when the original slot is definitely vacant; if a partial replacement occupies it or restore fails, backup remains recorded for guarded Undo. The new-file uncertain-existence hole is closed conservatively by `b16b507`. These paths were read, not run here. There is no claim of automatic rollback over an occupied target, interruptible mid-file copy, or same-host partial-failure safety.
- Round-1 approvals for `b3fb471` (SC-16), `ac5554e` (SC-08), `093db91` (SC-05), and `487ffca` (SC-07) remain unchanged. Relevant FE tests were included in this combined run. Backend approvals remain static pending lead's Rust results.

## Findings, scope, and residual limits

**No new changes requested in round 2.** The narrow same-host SC-01 scope decision was explicitly supplied by lead; it does not erase the known safety gap. A failed same-host rsync still can return before backup collection/journal finalization, and same-host cancellation/session locking remains open.

`b16b507` retains uncertain outputs in history; this does not itself prove immediate Undo cleanup if fingerprint collection also fails. Existing stamp/stale protection should preserve data rather than guess. Rust fault-injection/undo validation is still required in lead's slot. The new mocked Rust test is not a live server or native-disk failure reproduction.

The relay guard is defensive backend enforcement, not implementation of cross-host Sync. Unsupported combinations still rely on the existing localized explanation directing users to Compare → Apply/Merge. SC-12/SC-14/SC-35, archive-browse mutation gating, collapsed one-sided-directory ignore semantics, and other parked items remain backlog; no claim that this round fixes them.

## Exact commands and independent results

Read-only inspection:

```sh
git status --short
git rev-parse HEAD
git log --oneline 76b9b6e..ux-smoke/sync-opus
git show d165503 --
git show 6083f1a --
git show b16b507 --
git show 912bf01 --
cat /tmp/duet-ux-smoke-worktrees/sync-opus/REVIEW-sync-round1.md
```

Applied the immutable target snapshot without index changes (equivalent to the requested branch diff at observed tip):

```sh
git diff 76b9b6e 912bf01 -- . ':(exclude)REVIEW*' ':(exclude)CHECKPOINT*' > _report/round2-opus-all.patch
git apply --check _report/round2-opus-all.patch
git apply _report/round2-opus-all.patch
```

All succeeded. Backed up gitignored `src/types/bindings.ts` as `_report/round2-bindings.original.ts`. Hand-synced exactly two IPC changes: `fsMergeBidir(left, right, rules: CompareRules, detectRenames)` plus invoke `{ left, right, rules, detectRenames }`, and actual `ThreeWayStatus` union now includes `unreadable`. The union replacement was bounded by the next type declaration and asserted; unlike the R1 temporary edit, it updated the real type. No generation or Cargo invocation.

ONE focused Vitest process:

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/compareRules.test.ts src/lib/threeWayBase.test.ts src/components/dialogs/CompareDialog.test.tsx src/components/dialogs/ThreeWayDialog.test.tsx src/components/dialogs/__review__/sync-compare-compare-flow.test.tsx --reporter=verbose > _report/round2-vitest.log 2>&1
```

**Exit 0; 5 files passed, 30 tests passed; duration 6.33s**, start 02:14:36 as printed. Includes original reviewer SC-11 test port, ignore-only and combined late-prefill cases, initial source-aware tolerance, Merge rules, recompare/verify stale-response protection, 3-way base validation and unreadable row display. The unchanged SC-38 omitted-list-count `it.fails` is included among the green tests; do not call that defect fixed. Evidence is **mocked-FE-test reproduced**, not live app/SSH. A non-fatal Node localstorage-file warning remains. Full log `_report/round2-vitest.log`.

ONE TypeScript check, sequentially after Vitest:

```sh
pnpm exec tsc --noEmit > _report/round2-tsc.log 2>&1
```

**Exit 0, no diagnostics**; log `_report/round2-tsc.log` is empty. Applies to the hand-synchronized local generated types. Main must regenerate canonical bindings in its authorized slot; no generated file is committed by reviewer.

**Rust: static only, cargo pending.** No cargo build/test/check/clippy, `pnpm gen:bindings`, `pnpm build`, full Vitest, repeated check, dependency install, native app or actual server test was run. Lead's future Rust results are not incorporated or inferred from Opus's report. Test fixtures reviewed use IPC mocks or tempdirs, not actual user paths/data.

## Reversal and final state

After both processes finished:

```sh
git apply -R --check _report/round2-opus-all.patch
git apply -R _report/round2-opus-all.patch
git diff --name-only
git diff --cached --name-only
git status --short
git rev-parse HEAD
```

Reversal/check succeeded. Restored bindings byte-for-byte from `_report/round2-bindings.original.ts` using Python read_bytes/write_bytes. Tracked diff and staged diff are both empty; implementation-added files were removed by reverse patch. HEAD remains base `76b9b6e8b61608168b42a135a7a888422a3b1c60`. Only reports/checkpoint and `_report/` evidence remain untracked. No checkout/reset/clean, commit, sandbox widening, main-checkout edit, or additional reviewer source modification.

Review complete; reviewer idle. Overall approval is for the agreed code/scope, with Rust execution still a pending integration gate and same-host SC-01 explicitly open.
