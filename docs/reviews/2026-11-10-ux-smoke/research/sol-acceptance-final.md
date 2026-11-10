# FINAL MAIN acceptance — PASS (FE-MOCK), 4/4

Exact integrated main source: **32760e9a808b05c9b71b6077f7e0b2c57289bb6b**.
Research branch/HEAD retained: ux-smoke/research-sol / **76b9b6e8b61608168b42a135a7a888422a3b1c60**.
Main checkout HEAD was read-only verified at the same 32760e9 hash before copying. No partial team branch used.

## Snapshot provenance / byte comparisons

Commands (all successful):

```text
cp src/types/bindings.ts _research/bindings.final-base.ts
git diff 76b9b6e 32760e9 -- src > _research/main-32760e9.patch
git apply --check _research/main-32760e9.patch
git apply _research/main-32760e9.patch
cp /Users/ctmctm/Desktop/01_PROJECT/duet/src/types/bindings.ts src/types/bindings.ts
cmp /Users/ctmctm/Desktop/01_PROJECT/duet/src/types/bindings.ts src/types/bindings.ts
shasum -a 256 /Users/ctmctm/Desktop/01_PROJECT/duet/src/types/bindings.ts src/types/bindings.ts
```

`cmp` exited 0. Both generated bindings files SHA-256:

```text
63ce077ea00db72253c4a41410c32db7d1c349ce5feaabeab10348ac34d631fa
```

A read-only Python comparison loaded `git archive 32760e9 src` into memory and compared each file's bytes with the applied research snapshot. Exact result: **`Exact source snapshot byte comparison: 415 files; mismatches=[]`**. This includes branch-added source files, which remain untracked until patch reversal; no git add/index writes used.

Copied generated bindings retained as `_research/bindings.final-main.ts`. Read-only `/tmp/duet-ux-final-gen.log` showed:

```text
Compiling duet v0.1.0 (/Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri)
Finished `dev` profile [optimized + debuginfo] target(s) in 21.95s
Running `src-tauri/target/debug/export_bindings`
bindings written to src/types/bindings.ts
```

That generation was main's process, not this worker's. Copied bindings contain:

- line 333: `shellMenuOpen(paths: string[], scope: ShellScope)` (plural paths, resolving earlier stale-bindings limitation).
- line 1289: `fsExtractPlanBatch(archives: EntryRef[], keepBoth: boolean)`.
- line 1309: `fsExtractHere(archives: EntryRef[], policy: ExtractConflict)`.
- line 1323: `fsExtractHereRetry(archive, policy, password, batch)`.

## Exact command / output

Only this test file, one FE process, one worker:

`pnpm exec vitest run src/__ux_research__/primary-repro.test.tsx --maxWorkers=1 --minWorkers=1`

Exit **0**. Exact result output:

```text
RUN v2.1.9 /private/tmp/duet-ux-smoke-worktrees/research-sol
✓ src/__ux_research__/primary-repro.test.tsx (4 tests) 288ms

Test Files  1 passed (1)
     Tests  4 passed (4)
  Start at  02:44:22
  Duration  2.44s (transform 316ms, setup 0ms, collect 938ms, tests 288ms, environment 668ms, prepare 65ms)
```

Time is 2026-11-11 Asia/Seoul. Node emitted `--localstorage-file was provided without a valid path`; no collection/harness/uncaught errors occurred, all four desired-behavior tests passed.

## Acceptance evidence

| Case | Result | Exercised behavior |
| --- | --- | --- |
| A: a.zip + b.7z + c.tar.gz selected; right-click b.7z | PASS (FE-MOCK) | Actual App contextmenu callbacks retain all selected archives. Menu exposes enabled `extract-here` first and `extract` second. Each action independently reaches extract execution IPC with exactly the three archive names. |
| A mixed control: same selection + readme.txt | PASS (FE-MOCK) | Each enabled extract action excludes readme.txt and sends all three archives to execution IPC. |
| B: three archives selected | PASS (FE-MOCK) | Windows+local More options appears; lazy loader reaches shell-menu command with all three full paths. |
| B mixed control: same selection + readme.txt | PASS (FE-MOCK) | More options sends all four selected full paths, including the ordinary file. |

For Extract here, harness reads actual useUIDialogs payload, asserts all three archives, renders **real ExtractHereDialog**, clicks actual **Extract** button, asserts the default policy `keep_both`, then invokes **real runExtractHere** through the confirmation callback matching App's close-dialog → runExtractHere flow. IPC mock returns one task dispatch per archive. No direct test-made extract IPC call substitutes for confirmation.

For extract-to-folders, real action calls fsExtractPlanBatch; IPC mock returns three successful ExtractPlanItem records with distinct archive names/plans and no conflicts; real action calls fsExtractExecute for each plan. Per-action capture is reset; assertions require execution, not merely batch planning, and detect `/extract/i` command calls. This acceptance does not cover an existing destination conflict/password/retry/cancellation.

## Limits: mocked transport versus real wrappers

**This is FE-MOCK acceptance, never live-app/native/Bandizip verification.** Actual App openEntryMenuAt/onEntryContextMenu callbacks are AST-isolated from the exact source (to avoid unrelated startup hooks), driven by React contextmenu on b.7z. Actual menu builder, pane/dialog stores, archive actions, shell adapter, and extraction dialog execute. The entire `commands` export is replaced by a recording mock proxy; generated binding wrapper functions and TAURI_INVOKE are **not executed**.

Consequently, byte-matching current regenerated bindings resolves the earlier *stale artifact* concern and shows the supplied signatures include both IPC batches, but this run does not prove wrapper serialization/native command registration or Rust backend behavior. Main's tsc/full Vitest/native gates remain separate evidence. No actual extraction, shell extension population/command invocation, filesystem mutation, SSH/server access, or real Windows UI occurred.

## Restoration / hygiene

```text
cp src/types/bindings.ts _research/bindings.final-main.ts
git apply -R --check _research/main-32760e9.patch
git apply -R _research/main-32760e9.patch
cp _research/bindings.final-base.ts src/types/bindings.ts
cmp _research/bindings.final-base.ts src/types/bindings.ts
```

All exited 0. Tracked diff empty; final status:

```text
?? _research/
?? src/__ux_research__/
```

No implementation, commits, .git writes, main/team checkout writes, cargo, bindings generation, builds, full suite, or other test files run. Own research artifacts and snapshots remain uncommitted.
