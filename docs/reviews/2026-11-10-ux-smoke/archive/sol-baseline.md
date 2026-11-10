# Sol baseline — Phase A

Branch `ux-smoke/archive-sol`, base `76b9b6e8b61608168b42a135a7a888422a3b1c60`.
Read CLAUDE.md, ARCHITECTURE.md and SPEC-R1.md. Production source unchanged.

## Scope and evidence

`src-tauri/tests/ux_smoke_archive_sol.rs` uses real zip, tar.gz and single gzip fixtures constructed in-test; real LocalFs, extract_plan, extract_execute and persisted tempdir journal. Undo runs real core undo_cleanup through existing support/undo_fixture.rs: its filesystem delegates to LocalFs, except trash is a rename inside another TempDir. No OS trash, user files, SSH server or live app is touched.

- Single zip output is `<stem>/zip.txt`, not alongside the archive; undo removes output and retains archive. Together with the mocked menu's literal English `Extract here` assertion, this reproduces the label/behavior mismatch.
- Existing `<stem>/original.txt`: plan flags conflict; execute needs no confirmation parameter, moves old folder into `.bak`, and writes new output. Journal backup content checked; undo restores original and removes backup/new content. UI absence of a conflict dialog is static source evidence in baseline triggerExtract (plan goes straight to execute), not a live dialog observation.
- `a.zip` + `a.tar.gz` planned before either executes: both plans choose `a/`, both conflict=false. Sequential execution replaces first result with second; first result survives only in second entry's `.bak`. Separate journal IDs and reverse undo restoration checked. This drives core directly; baseline UI blocks this sequence.
- Single `log.txt.gz` produces `log.txt` as a file, with byte-content and undo checks.
- Non-archive rejected with unsupported archive error; SSH 7z/rar/gz rejected as NotSupported before any file lookup or network operation. Remote source is synthetic; no live remote extraction claimed.

`src/lib/__review__/ux-smoke-archive-sol.test.ts` is explicitly mocked FE evidence: real menu builder, real pane selection state and real triggerExtract; mocked Tauri commands. Single archive label `Extract here`, two-selected archive menu has no extract, triggerExtract toasts extractSelectOne once and makes no plan/execute IPC calls. No native menu/live desktop smoke claimed.

## Commands and outcomes

- Initial `pnpm exec vitest run src/lib/__review__/ux-smoke-archive-sol.test.ts`: exit 1, 1 suite failed collection, 0 tests. Generated ignored bindings.ts absent in fresh worktree. Copied existing generated bindings from main checkout read-only into this worktree; no main writes.
- Second same Vitest command: exit 1, 1 passed / 1 failed. Test authoring issue: Vitest 2 lacks toHaveBeenCalledExactlyOnceWith. Replaced with supported call-count plus argument assertions.
- Initial `CARGO_BUILD_JOBS=2 cargo test --test ux_smoke_archive_sol` (cwd src-tauri): interrupted exit 130 during fresh dependency compilation, no tests executed. Copied existing debug build cache into this worktree to accelerate local build; main cache read only.

Final focused results pending.

- Final Vitest run: exit 0, 1 test file passed, 2 tests passed (duration 60.08s). Both requested mocked FE baselines reproduced.
- `pnpm exec eslint src/lib/__review__/ux-smoke-archive-sol.test.ts`: exit 0.
- Prettier check initially exit 1 after matcher edit; applied Prettier. Final `pnpm exec prettier --check src/lib/__review__/ux-smoke-archive-sol.test.ts`: exit 0.
- `rustfmt --check --edition 2021 src-tauri/tests/ux_smoke_archive_sol.rs`: exit 0.
- `git diff --check`: exit 0 (new files untracked at time of check).
- Cached focused cargo attempt exited 130 during duet compilation, no tests executed. Lead subsequently confirmed SIGINT is intentional RAM resource control, not a product regression.
- Restarted focused cargo attempt stopped on lead CARGO FREEZE. Rust execution remains UNVERIFIED; no Rust pass/fail claim. Required queued command (cwd this worktree's src-tauri): `CARGO_BUILD_JOBS=2 cargo test --test ux_smoke_archive_sol`.

Cargo freeze respected from receipt; no further cargo/build/bindings commands until slot granted. No live app smoke performed. Baseline assertions intentionally lock current defects and may be inverted/adapted for R1 regression coverage.
