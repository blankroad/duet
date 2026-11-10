# True extract-here / each-to-folder — Round 3: APPROVE

Reviewed ccf8029, 771b53b, f027487 and opus-R1.md R3 section. Applied `git diff 905bc2f f027487 | git apply` successfully, working-tree only, preserving own baseline inversion edits. No cargo, clippy, generation, staging or commits.

**Final review verdict: APPROVE. No remaining blocker identified in the three requested scenarios.** Final Rust runtime/compile validation is lead-owned and pending append, not represented as independently passed here. Prior documented external-race/crash/cancellation limitations remain; approval does not turn them into guarantees.

## R2 findings closed

1. **Source protection — closed (ccf8029).** Batch planner seeds claimed names from *all* selected inputs before processing the first item. Therefore both orders `[a.zip.gz, a.zip]` and `[a.zip, a.zip.gz]` make the gzip destination unavailable: it receives `a (2).zip`, conflict=false, keep_both=true. Execution and password re-execution reserve a free destination rather than entering backup/Replace path. Future numbered candidates also skip claimed source names. This is order-independent set construction; no source-protection branch depends on which task runs first. New core test checks plans in both orders, executes the gzip-first order, verifies both sources byte-identical/no .bak and re-executes to a (3).zip. **Coverage precision:** test does not independently execute both orders; reverse-order behavior is supported by static common-path analysis, not two executed scenarios. Single legacy fs_extract_plan remains outside this new batch protection, documented and not used by the new menu. No new normal-batch regression found.

2. **Prompt isolation — closed (f027487).** Every displayed/queued prompt gets a monotonically unique promptId, independent of archive label/path. App renders ExtractPasswordPrompt keyed by promptId, which remounts PasswordPromptDialog and resets password/error/busy state when A becomes B, even with identical archive names. closeExtractPrompt checks the current promptId before closing, so a late A submit resolution cannot close B. The callback retains A's retry object, never borrows B's plan/password. Two rendered tests passed independently: same.zip in /a and /b, A wrong-state+typed secret then Cancel → B empty/no wrong-state; and deferred A submit cancelled before resolution → B remains current/empty, one IPC to A's plan only. Already-dispatched A work is not undone by closing its prompt; this is the existing task cancellation distinction, not cross-archive secret reuse. BE original batch protect list remains in Here retry state unchanged.

3. **Rollback honesty — closed (771b53b).** Lookup match now distinguishes Ok, NotFound, and all other errors for both backup and generated paths. PermissionDenied goes to `unknown`; success text requires undo_cleanup outcome Ok *and* no surviving backup/output/unknown entries. Non-Ok/unknown outcome returns “could not confirm” with executor kind/message and named recovery paths. Reviewed injected test with failed trash → shared PermissionDenied lstat flag, asserting unknown backup+output paths and “undo: Error”, then verifying actual backup bytes on disk. No cargo/test execution by Sol; waiting for lead evidence. This satisfies the bounded rollback mitigation without claiming write-ahead crash recovery.

## Independent checks (once each)

- `pnpm exec tsc --noEmit`: **exit 0**.
- `pnpm exec vitest run --maxWorkers=1 --minWorkers=1 --testTimeout=30000 src/components/dialogs/ExtractPasswordPrompt.test.tsx src/lib/extractActions.test.ts src/components/dialogs/ExtractDialogs.test.tsx src/lib/__review__/ux-smoke-archive-sol.test.ts`: **exit 0; 4 files, 28 tests passed**, 6.42s (20 actions/store/menu/notice, 2 mounted password isolation, 4 dialogs, 2 inverted baseline FE).
- `git diff --check`: **exit 0**.
- Delta affects nine intended files only; no bindings IPC changes, no fs/local.rs or source baseline changes from R3 delta.

The frontend tests use mocked commands; mounted password test reproduces the actual keyed App rendering pattern in a small Host rather than a live Tauri application. No live OS filesystem/remote/Windows or external writer test claimed.

## Delivery/status

Previous `_report/sol-baseline-inverted.patch` remains the two-file regression delivery, unchanged by R3. Its FE tests passed again above. Rust integration patch has not been compiled/run by Sol; lead will run core::archive, ux_smoke_archive_sol and clippy at lead head and append evidence. Existing lead @905bc2f 121/0/22 predates these R3 Rust changes and cannot be substituted for that final run.

No new blocker found. Known limits stay explicit: atomic name reservation is not atomic reserve-and-fill against external writers/ancestor changes; journal rollback does not cover a pre-append crash; running unpack/fresh-dir fill cancellation granularity remains limited; original folder Replace rollback behavior unchanged. No scope expansion or additional test runs requested.
