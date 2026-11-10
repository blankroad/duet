# Checkpoint — ux-sync-opus (paused until main nudges after 2026-11-11 02:05 KST)

- Worktree: `/tmp/duet-ux-smoke-worktrees/sync-opus`
- Branch: `ux-smoke/sync-opus`, HEAD `a3a271c` (base `76b9b6e`)
- Round 1 commits: SC-11 `863d38d`, SC-16 `b3fb471`, SC-08 `ac5554e`, SC-05 `093db91`, SC-07 `487ffca`, SC-01 `a3a271c`
- Uncommitted (untracked, intentional): `REVIEW-sync-baseline.md`, `REVIEW-sync-round1.md`, this file.
  `src/types/bindings.ts` is gitignored and was hand-edited locally: `fsMergeBidir` takes `rules`, `ThreeWayStatus` adds `"unreadable"`.
- Active builds/tests: none.
- State: all Round 1 code is written and committed. **No Rust code has been compiled or tested yet** (cargo was frozen).

## Next command (only after main/lead grants a cargo slot)

```
cd /tmp/duet-ux-smoke-worktrees/sync-opus/src-tauri && export CARGO_BUILD_JOBS=2
cargo test --lib three_way:: review_sync_failure_ sc40_ merge_and_apply ops_paths_tests
cargo test --test review_sync_compare_apply --test review_sync_compare_xcheck_opus --test review_sync_compare_xcheck_sol
```

Then fix any compile or test failures, and record the results in `REVIEW-sync-round1.md`. Details are in `REVIEW-sync-round1.md`.
