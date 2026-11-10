# SYNC round 1 — independent acceptance criteria

Reviewer: ux-sync-sol. Baseline: `76b9b6e8b61608168b42a135a7a888422a3b1c60`. Prepared before reading any Opus implementation tree or commits. These are review criteria and proposed test cases, **not claims that the new implementation passes**.

Scope from lead: SC-11, SC-16, SC-08, SC-05, SC-07, SC-01. Baseline FE-01 is the already-canonical **SC-07**, not a new issue. FE-02/FE-03/SC-12/SC-14/SC-35 remain backlog; they must not expand this round implicitly. No dependencies or product-policy changes are authorized by this checklist.

Resource rules (latest lead update): no Cargo (including build/test/check/clippy), `pnpm gen:bindings`, or `pnpm build` until lead relays a slot grant. Future focused Vitest must use `--maxWorkers=1 --minWorkers=1`, with only one FE test process across the team; Opus has priority, and reviewer must skip if availability is uncertain. No full suites or repeated tsc/test retries. Record binding changes rather than generating them. FE tests mock IPC; filesystem tests use isolated tempdirs or MockFs, never actual user paths, homes, or servers. Same-host mock/static evidence must not be called real SSH validation. Current task is complete; reviewer is idle pending lead's commit-review request.

## SC-11 — SSH comparison defaults to ±2 seconds

Acceptance:

- A fresh comparison with either side SSH starts with effective tolerance 2000ms. Cover local→SSH, SSH→local, SSH↔SSH same-host, and SSH↔SSH different-host. Local↔local stays at the existing default (0 absent an explicit preference).
- The rule shown in CompareRulesBar matches the rule used by the initial scan. Async settings prefill must not silently change a displayed 2s setting to 0 while its results were scanned at 2s.
- An explicit user selection of 0 (or 60000) and Recompare sends exactly that value, updates results, and remains visible after response. A source-aware default must not be reapplied on every render/recompare/verify/merge.
- Same size and absolute time delta ≤2000ms classify Same and default to skip. A size difference is not hidden by time tolerance; outside-tolerance differences retain ordinary classification. This is a timestamp heuristic, not proof of equal content; Verify remains available.
- Settings-fetch failure/missing field has the same source-aware default. Preserve ignore globs. Review behavior for saved nonzero tolerance and avoid silently replacing explicit preferences.

Adversarial cases:

| Fixture / action | Required observation |
| --- | --- |
| Same-size remote pair at deltas -2001, -2000, -1, 0, 1, 2000, 2001ms | Symmetric inclusive boundary; only ±2001 outside tolerance |
| Same timestamp, different sizes | Not Same; no false suppression of real size change |
| Settings promise resolves after the user changes the control | Late settings must not overwrite the user's new choice |
| Choose exact 0, Recompare, Verify, switch list/tree, then Merge | 0 remains the effective comparison/merge rule |
| Active pane is right; remote source switches sides | Default depends on both sources, not a particular visual pane |
| Saved zero versus missing/default zero | Existing Settings defaults to numeric 0; this alone cannot distinguish an old default from an intentional saved 0. Require a documented, consistent initial-open rule; do not claim new-open preference preservation unless the data model supports it. Explicit 0 chosen within the dialog must always work. |

Evidence wanted: mocked trigger test asserting actual `fsCompareDirs` args; dialog interaction test for effective control/recompare value; existing backend classification boundary tests or static trace while Cargo is frozen. The old `it.fails` injecting preclassified NewerLeft rows is not sufficient to prove source-aware scan defaults and may remain expected-failing even after this fix; do not mechanically remove it.

## SC-16 — require a real, unrelated 3-way base before results

Acceptance:

- Base prompt starts empty. Cancel/blank/whitespace produces no compare IPC or result dialog. Explain that the base is a third common-ancestor/snapshot directory on the active source.
- FE rejects clearly same/nested base↔left and base↔right, in **both nesting directions**, before presenting actionable results; show actionable localized guidance. Ambiguous identity/alias cases defer to authoritative backend validation rather than guessing across unrelated hosts.
- `fs_compare_three_way` rejects identical or nested base/left/right roots on the same actual filesystem before returning a plan. Include left↔right too so initial compare agrees with the existing apply guard. Apply retains its own guard against bypass/stale state.
- A third valid unrelated directory proceeds normally; same path strings on different actual sources remain legitimate. Source context must be included in the comparison. A base path equal to the remote right path string is not identical if base is local.
- No default-base “deletion” result that only fails after Apply. Existing kind/nonexistent-path errors remain handled without mutation.

Adversarial cases:

- base==left; base==right on same real FS; base inside left/right; base parent of left/right; left/right overlap; unrelated sibling `/tmp/base` vs `/tmp/base-old` must pass the component-boundary comparison.
- Trailing slash, repeated separator, `.`/`..`, root path, Windows drive/case/slash spelling, local symlink alias: backend must enforce canonical identity where existing path_guard supports it. Do not infer real Windows behavior from POSIX tests.
- Same-host SSH with separate connections/users/aliases; same IP with different known endpoints must not be mistaken for same filesystem. Remote names containing backslash must preserve it as a POSIX name character. Existing remote lexical/symlink limits should be stated rather than claimed solved.
- Blank prompt reopened after previous valid run must not inherit the left path. Active-right source must be used consistently.

Evidence wanted: mocked prompt/trigger tests asserting empty initial value and no compare call on invalid obvious input; backend command guard coverage for all relevant pairs using tempdirs/mock FS. During freeze backend behavior is static/unverified until granted tests. Separate deletion-count confirmation is not silently added to scope; record any remaining UX limitation.

## SC-08 — missing source must not displace destination into .bak

Acceptance:

- Before destination backup rename or destination creation bookkeeping, validate the source corresponding to the requested direction and resolved actual name. If source is already gone, return/record the failure or skip it with explicit reporting; do not report unconditional success.
- Existing destination stays at its original path with original bytes; no new backup rename, destination truncation, or irreversible cleanup occurs for an invalid/missing source.
- Enforce on relay **and same-host** paths, both ToLeft and ToRight. Shared helpers used by 3-way must not bypass the check.
- Permission/connection/stat failures are not classified as missing source or empty content. Successful-source path still uses appropriate direct same-host copy or relay; no new PC relay fallback for same-host operations.
- Earlier successfully applied rows keep their existing partial undo accounting; failure on the first unchanged row must not push an empty journal entry.

Adversarial cases:

| Case | Required / review question |
| --- | --- |
| Compare existing pair, remove source, Apply overwrite | Destination unchanged in place; no backup created |
| Compare source-only row, remove source before Apply | No fictitious created-file journal entry or empty output |
| Same-host SSH source connection differs from destination connection | Check source with source connection/path, not destination credentials |
| Directory source removed, dangling symlink, type changed after scan | Reject unsupported/invalid source before mutating target; do not follow links contrary to FS contract |
| NFC/NFD resolved filename and literal remote backslash | Validate the exact path subsequently copied, not an unresolved normalized surrogate |
| Source check succeeds, then source disappears/copy fails | Preflight does not eliminate TOCTOU. Inspect existing failure recovery/journal behavior; explicitly state residual race if rollback is outside the committed scope. Do not advertise atomicity from a precheck alone. |

Evidence wanted: MockFs/isolated filesystem tests asserting operation ordering and unchanged destination on missing/stat-error source; same-host path coverage or a clearly documented static-only review if no suitable mock. FE callback mocks alone cannot prove this guarantee.

## SC-05 — unreadable 3-way subtree must never mean deleted

Acceptance:

- Distinguish an actually absent side from failed listing of an existing side. PermissionDenied, connection failure, I/O errors and failed root lists must not become empty maps.
- On unreadable/uncertain subtree, either fail the comparison with context or represent that subtree as unreadable/conflicted and exclude it from auto-apply. No RightDeleted/LeftDeleted or spurious additions/copies derived from incomplete evidence.
- Apply recomputation must use the protected logic too. If preview was readable but apply-time read fails, do not mutate the opposite readable subtree on that incomplete classification.
- Legitimately absent folders still produce correct additions/deletions. The walker often recurses using a path for a side known absent in its parent listing; that known absence must not be conflated with “we could not read an existing directory.” Do not simply fail every NotFound and thereby break valid add/delete workflows.
- No silent catch-all `unwrap_or_default` on uncertainty. Keep useful error/source/path context; avoid presenting an incomplete plan as fully safe.

Adversarial cases:

- Inject list failures independently on **base**, left and right, at root and nested levels; each of PermissionDenied, disconnected SSH and generic I/O. Healthy sibling has a real change: all-or-nothing error is acceptable; partial-safe plan requires explicit uncertainty and exclusion.
- `base/sub/file` and `right/sub/file` exist; left/sub list denied: must not trash right/sub/file. Mirror left/right case.
- Existing directory disappears between parent list and child list: not reliable evidence of intended deletion. Distinguish from directory absent in the successful parent listing.
- Legitimately missing left/sub with base+right/sub present must still allow left-deletion classification; brand-new left/sub with missing base/right must still be an addition.
- Read succeeds during preview but fails during queued apply; inspect that no deletion/copy in the affected subtree runs. If safe work already happened earlier, preserve its partial undo accounting.

Evidence wanted: deterministic MockFs with error injection and assertions on returned plan/error and mutation calls. Real chmod tests can vary under elevated users; prefer explicit mock errors. Do not call a frontend mock plan a backend unreadable-tree reproduction.

## SC-07 (baseline FE-01) — Merge uses the rules that produced the visible plan

Acceptance:

- `CompareRules` reaches Merge through the full chain: trigger/initial plan → CompareDialog effective rules → onMerge → App → `fsMergeBidir` binding/command → core merge comparison. The accepted ignore/tolerance values must not be replaced by `CompareRules::default()`.
- Initial open with saved rules works even if the user never clicks Recompare. A successful Recompare replaces both displayed plan and its associated merge rules together.
- Failed/stale recompare does not attach new rules to old displayed results. Editing controls without completing Recompare must not silently merge an unreviewed scope. While recompare is in flight, either disable mutation actions or ensure they use the last successful plan/rules.
- Ignored files/subtrees remain untouched in relay/local and same-host merge, including when detecting renames. Keep existing basename glob semantics; do not invent new slash glob behavior in this fix.
- Merge remains add-only and refuses truly truncated comparisons. Existing scope/display filters (SC-35) are backlog, distinct from comparison ignore rules.

Adversarial cases:

| Sequence | Expected |
| --- | --- |
| Open with ignored `.git`, `node_modules`, `*.log`; one visible unique file; Merge | Only visible-scope eligible unique files copied; ignored directories never traversed/copied |
| Recompare A→B, B succeeds, Merge | B supplied end to end, not initial A or later global settings |
| Recompare B fails or an older response arrives after C | Plan and effective rules stay paired with the last accepted result |
| Edit rule input but do not Recompare; Merge | Last accepted comparison rules used, or explicit recompare required |
| Excluded subtree has >5000 entries | Excluded entries do not cause merge truncation/refusal |
| Toggle rename detection with active rules | No ignored rename candidate reintroduced or copied |
| Explicit 0/2000/60000 tolerance after Recompare | Exactly selected value crosses merge IPC even if unique-file subset usually does not change |

Binding note: supplied baseline `src/types/bindings.ts` currently defines `fsMergeBidir(left, right, detectRenames)` and ComparePlan without stored rules. Implementation will need a compatible rules-bearing command/type contract and synchronized callers/tests. Record exact changed signatures for lead generation in an authorized slot; **do not run generation**. Mocked Vitest can pass with a stale generated signature, so a green FE run alone is not IPC type proof.

Evidence wanted: interaction test captures Merge callback after initial/recompared rules; App/caller test or static chain checks forwarding; backend regression verifies excluded copy targets and unchanged destinations. Coordinate IPC change with lead; no unrelated refactor.

## SC-01 — failed/cancelled Sync preserves recoverability

Acceptance:

- Local sync must finalize actual partial mutations into a durable journal entry before propagating failure/cancel. This includes copied files, backups still needed, created directories, and any completed prune trash moves. Do not exit via `?` before finalization once state changed.
- If failure/cancel occurs after moving an existing destination to .bak but before replacement finishes, restore the original to its original path where safe. Do not destroy its only surviving backup if restore fails. Recovery failure must be visible and its remaining backup recoverable/accounted for.
- Do not roll back earlier successful files silently and then journal stale paths, or journal a restored backup as though it still exists. Created paths, source pairs and stamps stay aligned for undo/redo.
- Failure/cancel before any actual mutation must not create an empty journal entry. A planned path or “processed unchanged file” count is not proof of mutation. Directory-only creation and trash moves **are** mutations and must not be discarded as “nothing applied.”
- Undo after partial failure/cancel targets that partial Sync, not the user's preceding unrelated operation, and restores previous contents subject to existing fingerprint/stale protection. Subsequent user edits must not be overwritten or deleted by unsafe cleanup.
- Same-host rsync nonzero exit/transport failure/cancel cannot bypass collection/accounting for actual created outputs and backups. Predicted dry-run outputs are not proof they were created. Preserve failure status after recording recovery, do not report success merely because journal push succeeded.
- Distinguish “cancel requested” from actual transfer stopped. Do not claim prompt remote/channel cancellation if implementation only waits for rsync to finish; record that limitation against SC-01/SC-24/SC-32 explicitly. Avoid blind retries after partial remote mutation when cancelled.

Adversarial cases:

| Injection point | Expected |
| --- | --- |
| Token already cancelled before work, or first list/stat fails | No data mutations; no new empty journal record |
| Copy file A succeeds; cancel before B | A tracked in partial Sync; cancelled outcome preserved; B untouched |
| Existing B moved to backup; copy fails before writing | B restored; A (if any) stays undoable; no vanished-original path |
| Copy writes partial B, then fails | Original recovered safely; partial replacement handled without permanent loss; no stale backup entry |
| Backup rename itself fails | Original intact; no fictitious backup; earlier work still finalized |
| Restore rename fails or user concurrently creates destination | Preserve backup; do not clobber concurrent data; expose recovery failure/remaining state |
| New-file copy fails before creation vs after partial creation | No empty record for absent path; partial output accounted for if it exists |
| Only mkdir happened before cancellation | Directory creation accounted for; do not equate zero completed files with no mutation |
| Prune trashes A, fails/cancels at B | A's trash restore recorded; B untouched; original failure preserved |
| All scanned files unchanged; cancellation/error later | No empty record solely due to processed-file count |
| Same-host rsync exits 23 after some creates and backups | Collect real effects; partial journal; nonzero outcome visible |
| Remote collection/journal push fails after actual writes | Do not report success or discard backups. Report the recovery limitation; ensure no unsafe deletion in fallback |
| User edits a partial output before Ctrl+Z | Existing fingerprint protection honored; newer data preserved |

Evidence wanted: deterministic tempdir/MockFs failure injection and journal assertions, plus undo verification of actual resulting contents. No fake home path or real server. Review local and same-host branches separately; if only local is fixed, report same-host SC-01 as unresolved rather than treating issue ID as globally closed. Rust results await slot grant; this criteria document does not run or authorize them.

## Review decision rules

- Review actual diff, affected call chains and tests against the above, then run only permitted focused checks in this worktree. No reading Opus tree until lead requests commit review.
- For each item report pass / needs changes / unverified with exact evidence type and command. Static code evidence can identify a defect; no test execution means no tested guarantee.
- Convert a matching `it.fails` into a regular regression only when its expectation matches the fixed scope. An obsolete injected-plan expectation can legitimately stay expected-failing; state why. Any newly green `it.fails` is a failing test-suite result until its marker/expectation is reviewed.
- Resource cancellation of a Cargo process by main is intentional, not a product failure; never retry under freeze. Binding drift is a build-contract gap to report, not permission to generate.
