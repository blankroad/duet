# L3 independent review — round 1

- **dfc74b3 — CHANGES** (UX-SHL-04 / fileops-36).
- **f52945a — APPROVE** (test-title relabels UX-SHL-11/12 only).
- **b9b5ee5 — APPROVE** (ignored-test label UX-SHL-10 only).

Reviewed `git show` and complete relevant source at the target commit, without applying it. **No tests/Cargo/osascript/pasteboard operations run.** Findings below are static interleavings, not reproduced native failures. Windows runtime **UNVERIFIED**.

## Blocking findings

### 1. P2: Windows check/clear can erase another app's clipboard

`src-tauri/src/platform/file_clipboard.rs:145-149` reads the sequence **before** `OpenClipboard`. Interleaving: sequence equals duet's saved version → another app writes unrelated content → duet opens successfully → `EmptyClipboard` clears that unrelated content. The current code does not recheck while holding clipboard access.

A second attribution window is at **`:224-225`**: `drop(_guard)` closes clipboard, another app writes, then `GetClipboardSequenceNumber` returns the other app's version. `set()` stores that version as duet-owned, so even a later uncontended remote copy can erase unrelated content. Reading after Close is implemented as documented, but does not prove the returned sequence belongs to duet's write.

Required: make the ownership test and empty operation occur under one successful open, and tie ownership to the actual duet write rather than an unprotected post-close sample. If post-close sampling is necessary, validate a unique duet ownership marker under the clipboard lock before clearing. Add deterministic API-seam tests injecting an external write in both gaps; cross-clippy cannot cover these races.

### 2. P2: OWNED mutex does not serialize OS operations; take loses retry state

`file_clipboard.rs:84-86` performs the OS write before acquiring `OWNED`; **`:97-99`** takes the marker and releases the mutex before OS clear. Concurrent spawn_blocking calls can therefore finish marker publication out of order:

1. local set A writes version A, pauses before storing it;
2. local set B writes version B and stores B;
3. A stores A over B;
4. remote clear sees version B != A and leaves stale duet B behind.

Also, remote clear during an in-flight local set can see None and do nothing, followed by the older local request publishing its stale payload. This is especially relevant now that commands explicitly use independent `spawn_blocking` tasks (`commands/system.rs:877-879`).

Separately, `g.take()` consumes ownership even if `clear_os_if` fails (e.g. Windows clipboard busy). Further remote copy/cut attempts no longer retry, leaving the original stale file payload indefinitely. No user-facing feedback is guaranteed because FE ignores the command Result.

Required: serialize the complete duet OS set/clear + marker update operation. Preserve marker on retryable clear error; discard it only after successful clear or confirmed ownership loss. Consider request ordering for rapid local→remote copy. Add fake-OS barrier/failure tests; do not use general pasteboard for concurrency tests.

### 3. Ownership promise is also stronger than the macOS implementation

`src-tauri/src/platform/macos.rs:47-48` performs separate `changeCount` read and `clearContents` operations. An unrelated writer between them is not protected by executing both statements in one JXA process. Similarly, **`:31-34`** reads the version after writing; another writer between those operations could be attributed to duet. The private-board test verifies sequential version changes, not either interleaving.

This is a static limitation, not an observed macOS failure. Do not claim “unrelated user content is never cleared” based on a version check alone. Establish an OS-supported conditional/ownership mechanism or explicitly agree on a conservative fallback/limited best-effort contract with main. The Rust mutex requested above addresses duet-to-duet concurrency, not external-app races.

### 4. New private-board test documentation recommends a dangerous broad run

**`macos.rs:194`** recommends `cargo test --lib platform::macos -- --ignored`. That includes the **preserved** `set_file_clipboard_writes_real_pasteboard` at **`:218`**, which writes the general clipboard (`:226`). Thus following the new private-board test's instructions also changes the user's clipboard.

Replace the comment with the exact private-board test filter, e.g. `cargo test --lib platform::macos::tests::clear_if_owned_clears_only_our_unchanged_contents -- --ignored --exact`. **I ran neither command.**

## Checks without findings

- Windows clear pairs every successful Open with Close, including Empty failure. In `set_windows`, guard is created only after successful Open; `drop(_guard)` moves it, so the success path closes exactly once before the sequence sample. Error paths close through Drop. The ownership windows above remain despite correct pairing. Existing HGLOBAL failure cleanup/OpenClipboard(NULL) concerns predate this change and are not new findings.
- JXA source is fixed, paths/board/count are distinct argv entries after `--`, and paths use `argv.slice(1)`. No path interpolation into executable JS/shell text. `""` selects generalPasteboard; the private test supplies nonempty `duet-test-<pid>` and tempdir fixtures. Both clear/set wrappers pass `""` intentionally in production.
- Mixed local+SSH input returns NotSupported from `local_paths_of`; it does not export a misleading local subset. It takes the same conditional-clear branch as all-SSH, then preserves the original error. In-app clipboard semantics are unchanged.
- `spawn_blocking(move || ...)` owns the items Vec and keeps blocking OS/script work off the async executor. Join errors propagate.
- Clear warning logs the OS/script error, not item paths, credentials or command argv. JXA clear uses only board name/version. No explicit new secret/path logging found.
- Linux set records None and clear is a documented no-op, so UX-SHL-04 is intentionally unresolved there. Empty local input still returns the existing no-path error.
- Existing ignored **general-pasteboard** test is preserved and still ignored. New private-board test is separate; it does not use generalPasteboard when passed its nonempty name.

## Supplied evidence (not rerun)

Lead reports: `cargo test --lib platform::` **19 passed**; exact ignored private-board test **passed on real macOS NSPasteboard**, never general; windows-gnu clippy `-D warnings` clean including dfc74b3. These support compilation and sequential private-board behavior; they do not exercise the race schedules above. Commit's original “UNTESTED” message is superseded by this supplied lead evidence.

No product/test files changed for L3; only this uncommitted report was written. Previous L1/L2 worktree edits remain intact.
