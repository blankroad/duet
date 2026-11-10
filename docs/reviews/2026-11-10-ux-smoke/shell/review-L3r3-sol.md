# L3 round 3 — final static clipboard review

**e0ee94e + d0fc43d — APPROVE**, with dfc74b3 as base. No remaining blocking finding in the requested corrections. Reviewed via git show; not applied. **No Cargo, tests, osascript or clipboard operations executed by reviewer. Windows runtime UNVERIFIED.**

## Findings closed

1. **Windows ownership races: resolved by e0ee94e.** File list and nonce are written during one clipboard-open interval; clear reads the marker and empties while still open. No post-close version attribution or pre-open equality check remains. Guard pairing and system memory ownership remain intact.
2. **Serialization/retry: resolved by the pair.** One OWNED mutex covers OS callback and state publication. `clear_with` returns on Err before clearing its nonce. d0fc43d's `MarkerRead`/`marker_verdict` (`platform/file_clipboard.rs:205-224`) now distinguishes absence/mismatched bytes from an unreadable marker. Registration failure, GetClipboardData failure for an available format, and null GlobalLock map to Unreadable/Io (`:244-255`), preserving the nonce for retry. Presence is checked under the same clipboard open. Only a confirmed missing/mismatched marker or successful clear forgets ownership. The added test composes Unreadable with clear_with and asserts ownership retention; no longer merely tests an unrelated synthetic Err.
3. **Introduced marker allocation leak: resolved.** At `file_clipboard.rs:335-344`, unsuccessful marker lock and failed SetClipboardData free the untransferred marker HGLOBAL. Successful transfer does not free system-owned memory. The prior CF_HDROP failure-cleanup debt is unchanged and is not reopened here.
4. **macOS residual race/documentation: correctly scoped.** The private marker removes version misattribution, but check and clear remain separate pasteboard operations. Updated `file_clipboard.rs` and `macos.rs` explicitly say the interval is small but **unbounded**, best effort and **not atomic**. Public wrapper `platform/mod.rs:32-34` now qualifies the guarantee for macOS and links to that limitation. Approval accepts that disclosed limited contract; it does not certify that unrelated content can never be cleared during a concurrent foreign write.
5. **Test instructions/general pasteboard: resolved and preserved.** Private-board comment still names the exact test with --ignored --exact (`macos.rs:197`) and warns against broad --ignored runs. The existing general-pasteboard test remains ignored. Neither was run by reviewer.

## Lead-supplied validation (not independently repeated)

On d0fc43d source, lead reports:

- `cargo test --lib platform::`: **47 passed**, including marker_verdict and state tests.
- Exact private-pasteboard test: **passed on real macOS NSPasteboard**, using its named private board, never general.
- `cargo clippy --target x86_64-pc-windows-gnu --lib -D warnings`: clean, **compile-only** Windows evidence.

The commit message records the same results. These cover pure state/error classification and sequential private-board behavior, not native Windows execution or elimination of the documented macOS race. Linux remains intentionally no-op for conditional clearing; ownership is cooperative (a private marker, not a security boundary).

No product/test edits or commits made. Only this uncommitted report written; previous worktree state preserved. This completes the allowed third clipboard review round.
