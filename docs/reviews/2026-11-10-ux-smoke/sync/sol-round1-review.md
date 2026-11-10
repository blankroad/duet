# SYNC round 1 — independent review

Reviewer: ux-sync-sol. Completed 2026-11-11 after lead explicitly resumed the user-paused review. Round **1 of at most 3**. Worktree: `/private/tmp/duet-ux-smoke-worktrees/sync-sol`, branch `ux-smoke/sync-sol`, HEAD `76b9b6e8b61608168b42a135a7a888422a3b1c60`.

**Overall verdict: CHANGES-REQUESTED.** SC-11 has a deterministic mocked-FE reproduction that loses an explicit tolerance choice. SC-01 improves local failure recovery but explicitly leaves the assigned same-host partial-failure scenario unresolved. Four other commits are approved on the reviewed scope; **all Rust results are static, cargo pending**. No Cargo command, binding generation, full suite, actual server, native Windows test, or real user-data operation was run.

Reviewed snapshot: `a3a271ce57dfbad8231c88901f2b6aa9178881cd` (six commits from base). References below are file:line at that snapshot, including the reviewer test while temporarily applied; product files have since been restored to base. The criteria were prepared independently in `REVIEW-sync-round1-criteria.md` before viewing implementation.

## Per-commit verdicts

| Commit | Issue | Verdict | Evidence and limits |
| --- | --- | --- | --- |
| `863d38d` | SC-11 | **CHANGES-REQUESTED** | Initial source-aware ±2s default works for either SSH side and keeps local default; new normal regression is appropriately about scan/recompare rules, not injected preclassified rows. But delayed settings overrides an explicit selection: R1-01 below. Six helper/trigger tests and revised compare-flow test pass; reviewer adversarial test fails. |
| `b3fb471` | SC-16 | **APPROVE** | `fileActions.ts:323-339` starts base empty, ignores blank/cancel, checks obvious same/nested base on matching sources, and gives localized guidance. `core/three_way.rs:137-144` checks all three root pairs before classification, preserving apply guard. Seven mocked prompt/trigger tests pass, including different-source same-path acceptance. Backend canonical/endpoint identity is delegated to existing path_guard; **static, cargo pending**. |
| `ac5554e` | SC-08 | **APPROVE** | `core/ops.rs:2779` checks resolved relay source before destination backup; `:2982-2985` checks same-host source using source connection before any target backup. Missing rows leave target intact, aggregate a named error, continue remaining rows, and avoid an empty journal when no change occurred. Other stat errors propagate. Existing partial-state handling remains; source-precheck TOCTOU is not eliminated. Both directions and same-host branch inspected; no real SSH claim. **Static, cargo pending**. |
| `093db91` | SC-05 | **APPROVE** | `core/three_way.rs:202-221` emits one Unreadable subtree warning for non-NotFound list failure and stops descent; `:44-50` makes it conflict/auto-apply excluded. Apply uses the same comparison and skips conflicts. Genuine absence remains an empty side. Frontend label/conflict-filter tests pass (2 tests). New status requires generated union synchronization. NotFound/race and native chmod behavior not proved by FE tests; **static, cargo pending**. |
| `487ffca` | SC-07 (baseline FE-01 alias) | **APPROVE** | `CompareDialog.tsx:104-107` commits rules only with accepted successful plan; failed/stale responses leave previous rules. `:283`, `App.tsx:2353-2357`, command and `core/ops.rs:1979-1987` forward those rules into merge recompare. Initial trigger stores initial rules in dialog state. Two new Merge callback tests and existing verify/recompare tests pass. Default-rules wrapper preserves old internal callers. **Rust static, cargo pending**. Inherited collapsed-directory behavior is noted separately below. |
| `a3a271c` | SC-01 | **CHANGES-REQUESTED** | Local mirror/prune outcomes now reach journal finalization before returning failure; created dirs count as mutations; restoring a vacant original slot avoids dangling .bak-only originals. But same-host failure still returns before recording actual work: R1-02 below. Local recovery was inspected, not executed; **static, cargo pending**. |

## Findings requiring action

### R1-01 — SC-11 delayed prefill overwrites an explicit exact choice (P2)

**mocked-FE-test reproduced**. `src/components/dialogs/CompareRulesBar.tsx:34-39` always applies settings after awaiting `settingsGet`, regardless of user edits. `tolTouched` controls persistence only; it does not protect the async prefill.

Reproduction: open a remote comparison with the second settings request pending → control starts at 2000ms → select Exact (0ms) → resolve settings with saved 0ms → control changes back to 2000ms. The next Recompare uses 2000ms despite the explicit exact choice, potentially hiding timestamp differences the user wanted to inspect. The same callback can replace edited ignore text.

The independent normal regression at temporary `src/components/dialogs/CompareDialog.test.tsx:209` failed **expected `0`, received `2000`**. This is a deterministic deferred-promise interaction, not timing speculation or a native-app test. Existing prefill had related late-write behavior; this commit's automatic remote floor makes the round-1 requirement to preserve an explicitly chosen 0 fail.

Requested change: seed the rule controls from the actual rules that produced the plan (now available through SC-07), or guard each async prefill against user edits/current request lifetime. Keep explicit 0 valid on recompare and do not persist the automatic remote default as a local default. Add/retain the delayed-settings regression.

Handover: **`_report/sc11-review-test.patch`** is `git diff a3a271c -- src/components/dialogs/CompareDialog.test.tsx`, containing only the reviewer's test addition. Apply on the reviewed six-commit snapshot. It is a deliberately normal failing regression, not `it.fails`. No implementation fix is bundled. `_report/SC-11-late-settings.patch` contains the identical earlier-named patch used for reversal.

### R1-02 — SC-01 same-host failure still loses partial undo history (P1 known safety gap)

**static code trace; cargo pending**, not a newly introduced regression. `src-tauri/src/core/ops.rs:1644-1661` still returns on transport failure/cancellation in retry handling or nonzero rsync exit. Backup collection and `journal.push` are later at `:1664-1695`. A same-host sync that copies some files or backs up overwritten files and then exits 23 still has no partial UndoSync entry. Ctrl+Z can therefore reach an earlier unrelated operation. The commit message explicitly states that same-host partial failure is unchanged.

Requested change against the assigned SC-01 acceptance: finalize actual remote changes/backups before returning the failure, filtering predicted dry-run creates to actual effects, or obtain explicit lead acceptance of a **local-only fix with same-host SC-01 still open**. This review does not reject the value of the local fix; it rejects reporting SC-01 globally fixed. Remote cancellation/session-lock behavior also remains a limitation and must not be advertised as solved.

## Nonblocking scope notes and unverified edges

- SC-11: `initialTolerance` covers SSH↔SSH by source-kind logic, but the helper tests explicitly exercise only mixed/local combinations. Saved zero is intentionally floored on a fresh remote open; the commit states this policy. The blocking finding concerns explicit 0 chosen **within** a dialog, which must work independently of saved-zero ambiguity.
- SC-08: the precheck does not guarantee source stability after it returns, nor validate all future copy failure modes. Keep partial journal recovery; do not advertise atomic overwrite. Same-host execution lacks test coverage in these commits; approval is static for that path.
- SC-05: the new code protects list PermissionDenied/connection/I/O failures. It still treats all NotFound as absent, including a directory disappearing after a parent list. This review does not claim a separately reproduced destructive NotFound case or make it a blocker. Deterministic MockFs coverage is preferable to relying only on chmod, whose effects vary with test credentials.
- SC-07: the targeted loss of dialog rules is fixed. A one-sided directory is still one collapsed CompareEntry (`core/compare.rs:441-452`); recursive copying that row does not independently apply ignore patterns to its descendants (`fs/mod.rs:314-323`, merge copy helpers). Thus a unique directory can include ignored descendant basenames. This is inherited Compare/copy scope behavior, not an introduced mismatch between displayed plan and Merge, so it is **not a round-1 rejection** of the forwarding fix. Do not claim this patch implements filtering inside every collapsed directory.
- SC-01 local: `mirror_file` restores a backup automatically only when the original slot is definitely free (`ops.rs:1439-1444`). A partial replacement already at that path is retained with the backup journaled for Ctrl+Z. Restore failure likewise preserves backup bookkeeping. No prompt mid-file cancellation is established; local copy helper uses its own never-cancelled token. These limits are visible in code, not independently tested here.
- The new-file error branch at `ops.rs:1446` records a created file only when post-failure stat succeeds. Uncertain post-failure stat is not conservatively recorded as `any_exists` does elsewhere; add a MockFs partial-write-plus-stat-error test when validating recovery. This is a remaining test gap/static concern, not a separately reproduced finding in this review.
- FE-02/FE-03/SC-12/SC-14/SC-35 remain parked per lead. No unrelated refactor or policy expansion requested.

## Commands and results

Read each requested commit with `git show <sha> --`; later reread relevant file-specific hunks. `git log --oneline 76b9b6e..ux-smoke/sync-opus` showed the sixth commit `a3a271c`; it was included. Only this worktree was edited; index was not touched.

Applied the five-commit snapshot, then SC-01 increment, retaining a complete immutable reversal diff:

```sh
git diff 76b9b6e 487ffca -- . ':(exclude)REVIEW*' > _report/round1-opus.patch
git apply --check _report/round1-opus.patch
git apply _report/round1-opus.patch
git diff 487ffca a3a271c -- . ':(exclude)REVIEW*' > _report/round1-sc01.patch
git apply --check _report/round1-sc01.patch
git apply _report/round1-sc01.patch
git diff 76b9b6e a3a271c -- . ':(exclude)REVIEW*' > _report/round1-opus-all.patch
```

All apply/check commands succeeded. Added one reviewer regression to a touched test file and exported the isolated diff. Hand-edited gitignored bindings for `fsMergeBidir(left, right, rules: CompareRules, detectRenames)` and its invoke payload. The new ThreeWayStatus union still needs proper generation/synchronization; see tsc result below.

ONE focused Vitest process, completed before the user pause; no rerun after resumption:

```sh
pnpm exec vitest run --maxWorkers=1 --minWorkers=1 src/lib/compareRules.test.ts src/lib/threeWayBase.test.ts src/components/dialogs/CompareDialog.test.tsx src/components/dialogs/ThreeWayDialog.test.tsx src/components/dialogs/__review__/sync-compare-compare-flow.test.tsx --reporter=verbose > _report/round1-vitest.log 2>&1
```

Exit **1**; **4 files passed / 1 failed; 27 tests passed / 1 failed**, duration **8.41s**. Sole failure is reviewer R1-01; all 27 existing/Opus tests in this selection passed (including the unchanged SC-38 expected-failure test). The old SC-11 injected-plan `it.fails` was replaced by a passing test of ±2s recompare args and resulting skip behavior; that change matches the fixed scope. Node emitted a non-fatal `--localstorage-file` warning. Full output: `_report/round1-vitest.log`.

ONE TypeScript check after explicit resumption:

```sh
pnpm exec tsc --noEmit > _report/round1-tsc.log 2>&1
```

Exit **2**, with four diagnostic sites: `ThreeWayDialog.test.tsx:18` and `ThreeWayDialog.tsx:22,36,39`, all because generated `ThreeWayStatus` lacks `unreadable`. My temporary enum edit did not update the actual union. No other TypeScript diagnostics were printed; do **not** claim tsc passed. Merge signature/payload had been hand-updated and produced no diagnostics. No retry or Cargo generation was run. Lead must synchronize the actual generated enum and command signature in the granted slot, then complete the gate. Full output: `_report/round1-tsc.log`.

Rust commands: **none**. Results for SC-16/08/05/07/01 backend are **static, cargo pending**. Lead-provided future Rust output is not yet incorporated into this report; no claim about Rust test/clippy/build success.

## Restored worktree and handover

After checks completed, reversed reviewer test and the exact applied six-commit diff:

```sh
git diff a3a271c -- src/components/dialogs/CompareDialog.test.tsx > _report/sc11-review-test.patch
git apply -R --check _report/SC-11-late-settings.patch
git apply -R _report/SC-11-late-settings.patch
git apply -R --check _report/round1-opus-all.patch
git apply -R _report/round1-opus-all.patch
```

Restored `src/types/bindings.ts` byte-for-byte from `_report/round1-bindings.original.ts` using Python read/write. All reversal commands succeeded. Final `git diff --name-only` and `git diff --cached --name-only` both empty. HEAD remains base `76b9b6e8b61608168b42a135a7a888422a3b1c60`; only untracked checkpoint/review Markdown files and `_report/` evidence remain. No checkout/reset/clean, commit, sandbox widening, or main-checkout edit was used.

Reviewer is idle pending lead's next review request. This round needs R1-01 resolved, explicit disposition of same-host SC-01, and the pending generated-binding/Rust gates before overall approval.
