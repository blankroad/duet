# L3 round 2 — static review of e0ee94e

**Overall: CHANGES** — the primary Windows race and duet-operation serialization fixes are sound, but a low-level ownership-read failure is still treated as confirmed ownership loss, defeating the required retry behavior. Tests are pending the lead's lease; none run by this reviewer. Commit read directly, not applied. Windows runtime **UNVERIFIED**.

## Per-finding verdict

| Original L3 finding | Verdict | Evidence at e0ee94e |
| --- | --- | --- |
| 1. Windows pre-open check and post-close attribution races | **RESOLVED statically** | `platform/file_clipboard.rs:263-308` writes CF_HDROP + nonce marker within one open; `:219-235` opens first, reads nonce and empties before its guard closes. No sequence-number attribution remains. Marker memory is system-owned when successfully set; reads are size-checked and unlocked before emptying. |
| 2. Operations not serialized / take loses retry marker | **PARTIALLY RESOLVED — CHANGES** | `set_with`/`clear_with` hold OWNED across OS callbacks (`:121-125`, `:135-142`); Err returns before marker mutation. This fixes stale marker publication and normal clipboard-busy retry. But clear's platform adapter still returns Ok(false) on a GlobalLock failure (`:225-227`), causing `clear_with` to erase the marker (`:141-142`) after an uncompleted check. See required correction below. |
| 3. macOS ownership promise exceeds implementation | **RESOLVED as an explicitly limited best-effort contract**, with documentation caveats | `file_clipboard.rs:105-108` and `macos.rs:40-54` explicitly acknowledge that a foreign write between marker read and clear may be cleared. The marker avoids recording someone else's post-write version as ours. No claim of atomic NSPasteboard compare-and-clear is warranted. |
| 4. Broad ignored-test command can overwrite general clipboard | **RESOLVED** | `macos.rs:194-198` now gives the exact named private-board test and warns against broad --ignored. Existing general-pasteboard test remains ignored (`:238-251`). |

## Required correction: distinguish read failure from ownership loss

**`src-tauri/src/platform/file_clipboard.rs:225-227`**:

```rust
let p = GlobalLock(hmem) as *const u8;
if p.is_null() {
    return Ok(false);
}
```

A failed lock does not establish that the clipboard lacks our nonce. With a still-owned clipboard and a transient failed lock, `clear_with` sees success(false), discards OWNED, and no later remote copy retries. This is the same stale-payload outcome the revised state rules intend to prevent. Static path analysis only; no induced native failure test run.

Return `DuetError::Io` on inability to inspect an otherwise-present marker, retaining OWNED via the existing `?` path. Likewise, `owner_format()==0` at `:212-214` is a registration failure, not a confirmed foreign clipboard; preserve retry state rather than returning false. For GetClipboardData failures (`:221-222`), distinguish ordinary missing format from inability to retrieve a present format if the API reports both. Add a fake adapter/error test covering this classification; current `failed_clear_keeps_marker_for_retry` checks Err propagation only, not these swallowed failure branches.

## macOS residual scope and documentation

The substantive risk is now disclosed honestly: it is **best effort**, and an unrelated writer in the remaining check→clear gap can lose its content. That is a limitation accepted only under this revised contract, not proof of the original absolute “never clear unrelated content” condition.

Do not rely on the commit's “sub-millisecond” or code's “under a few ms” wording as a measured/hard bound: these are separate pasteboard calls and the process can be descheduled between them. Prefer “small but unbounded race window.” Also qualify the public wrapper's still-unconditional claim at **`platform/mod.rs:32-33`** (“other-app copies are not touched”) with the same macOS best-effort caveat/link. Neither code inspection nor a sequential private-board test proves a time bound or atomicity.

JXA remains fixed source with board/nonce/paths as argv after `--`; paths start at slice(2), nonce is converted to decimal text, and no user path is interpolated into JS. Empty board name intentionally means general; private test uses nonempty name. No new command injection issue found.

## Additional nonblocking observations

- New marker HGLOBAL at `file_clipboard.rs:299-308` is not freed when GlobalLock or SetClipboardData fails before ownership transfers. This is an **introduced 8-byte allocation leak on a marker failure path**, separate from the pre-existing CF_HDROP allocation failure cleanup debt. Use a small ownership guard/GlobalFree for unsuccessful transfer; not the reason for this round's CHANGES verdict.
- Nonce is timestamp XOR counter, not cryptographic random. Current docs describe the construction accurately; avoid treating it as a security credential. Clipboard ownership here is cooperative, not protection against another process intentionally copying the private format.
- Mutex serializes execution, not necessarily IPC arrival order across spawn_blocking tasks; no FIFO promise was added. Failed set preserves old marker; unmarked successful set drops it; Linux remains intentionally unmarked/no-op.
- New tests cover marked/unmarked writes, failed write, clear success/foreign/no-marker, retry after Err, and nonce sanity. They do not directly test Win32 failure classification or race scheduling. Private-board test now covers different nonce and unmarked foreign text without touching general. General-board test preserved and not run.

## Evidence / worktree

No tests/Cargo/gen:bindings/osascript executed, no product/test edits. Lead will append lease results; R1 private-board results are not claimed as validation of R2's marker implementation. Only `_report/review-L3r2.md` written, uncommitted. Previous worktree changes preserved.
