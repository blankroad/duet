# Lead BE R1 — independent review

**APPROVE statically with fixup `2fa109f`; runtime evidence remains pending.** Read actual commits `ababa6d2fbcd048baba2a0250e61f8d478c2f841`, `6a8330de6e2deae037f893db7bb9d7ff68182c67`, and the subsequently supplied `2fa109f` in the lead tree. No Cargo, FE, Docker, or generated-command tests run by Sol for this review. Other trees were not modified.

| Commit | Verdict | Evidence |
| --- | --- | --- |
| `ababa6d` (remote-11/25) | **APPROVE (static)** | `src-tauri/src/core/search.rs:434`, `:468`, `:536`; hidden-root filtering, record framing, shared parser and G-10 merge inspected. |
| `6a8330d` (remote-12), alone | **CHANGES** | New `remove_staging` originally only quoted its path before rm (`core/sudo.rs:175`); CLAUDE.md:44 explicitly requires a path-shape check immediately before deletion. Sent to lead during review. |
| `2fa109f` + `6a8330d` | **APPROVE (static)** | `core/sudo.rs:177–200` now guards cleanup before shell quoting/exec; `:280` adds valid/invalid path cases. Tests read, not run; carry this fixup with the original commit. |

## Search checks

- `-mindepth 1` excludes evaluation of the supplied root, so a hidden root no longer matches the descendant prune. Below it, the effective expression is `(hidden-name AND prune) OR (type AND size/time AND name AND print0)`. Implicit AND binds more tightly than OR; grouped type/name alternatives preserve that grouping. Hidden trees are pruned regardless of filters; with include_hidden the whole prune branch is omitted. Root exclusion is an intentional documented behavior change.
- `-print0` followed by the two-way NUL/newline translation preserves record boundaries: a filename cannot contain NUL; embedded LF becomes NUL, record NUL becomes LF, head counts records, parser restores embedded LF. Existing pattern quoting and type/size/time clause construction are retained. Content-search output contains no NUL, so its ordinary newline-delimited results are unchanged by `line.replace`. Content-search newline filenames remain a pre-existing limitation, outside the filename-search fix.
- File-level three-way merge against base `76b9b6e`, lead `ababa6d`, Opus `4af7519` completed with `git merge-file -p` exit 0. Reviewed output at `_report/lead-be-r1-merge/merged.rs`: both SSH search backends retain `exec_cancellable(session_mutex, &cmd, &cancel)`; no `.lock()` remains; the new builder call and NUL restoration remain. This is a static merge check, not an integrated compile.
- The GNU/BSD command forms are documented: [GNU find directory handling](https://www.gnu.org/software/findutils/manual/html_node/find_html/Directories.html), [FreeBSD find](https://man.freebsd.org/cgi/man.cgi?format=html&query=find&sektion=1). Three-digit octal tr operands are documented by [GNU tr](https://www.gnu.org/software/coreutils/manual/html_node/Character-arrays.html) and [FreeBSD tr](https://man.freebsd.org/cgi/man.cgi?format=html&query=tr&sektion=1). [BusyBox's manual](https://busybox.net/downloads/BusyBox.html) lists mindepth, print0 and prune, but features are compile-time configurable. This establishes intended syntax, not execution on every build. BusyBox tr octal/fixture behavior still needs the pending Alpine Docker run. Existing `-newermt` compatibility limits are unchanged by this commit.

## Sudo checks

- Parent mkdir is attempted before the UUID root; root mkdir errors now propagate before upload (`core/sudo.rs:235–236`, after fixup). Ignoring the parent result allows already-exists; a failed parent creation still surfaces when creating the child. A failed UUID mkdir does not trigger deletion of an existing directory.
- `stage_items` preserves the previous upload order/path replacement. An upload failure removes only the app-built staging root, then returns the original failure. Successful staging is cleaned after sudo_run resolves, before propagating its error. No new destructive cancellation was introduced.
- The cleanup argument is constructed from remote home + fixed `.duet-sudo` + generated UUID. The fixup checks the final component parses as UUID, the immediate parent is `.duet-sudo`, and there is no ParentDir component before issuing quoted rm. Invalid root/parent/token/path cases are represented in its new unit test. The helper has no user-selected/list-derived root caller.
- `build_script(...)?` can still exit after staging but before cleanup; this was already true before these commits. This review does not claim all possible staging leaks are solved.

## Evidence boundary

Lead reports their leased `cargo test --lib -- core::search core::sudo`: **32 passed, 0 failed, 2 ignored**. This is attributed lead evidence, not Sol execution. It predates the newly reviewed guard test. Newline framing, hidden-root commands and root exclusion have source tests; actual Docker `r12_sudo_staging_fails_every_time_without_parent` and `c21_search_korean_space_hidden_root_backslash` are pending, as is execution of the guard test. No new Cargo command was started.
