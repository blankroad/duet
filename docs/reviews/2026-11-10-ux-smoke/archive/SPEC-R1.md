# archive R1 spec — multi-archive extract (UX-ARC-01 = AR-01, + AR-02/03/04)

Base 76b9b6e. Implementer: ux-archive-opus (`/tmp/duet-ux-smoke-worktrees/archive-opus`, branch `ux-smoke/archive-opus`).
Reviewer: ux-archive-sol (`archive-sol`). Lead cherry-picks onto `ux-smoke/archive`.

## Behaviour (explicit)

1. **Entry point.** In-app context menu archive section (`src/lib/entryMenu.tsx`, the `extract` item only).
   - 1 archive selected: item "폴더로 압축 풀기" / "Extract to folder" (AR-02 label fix; behaviour unchanged).
   - N≥2 selected, k≥1 extractable archives: "각각 폴더로 압축 풀기 (k개)" / "Extract each to its own folder (k)".
   - Extractable = `kind === "file"` && `canExtractArchive(name, source)` (remote keeps the 7z/rar gate per archive).
   - No extractable archive in selection → item hidden (same as today).
   - Native OS "More options" = shell team (UX-SHL-01). Do not touch `App.tsx`.
2. **Destination model.** Per-archive: each archive extracts to its own `<stem>/` next to it (single-file `.gz` etc.: its `<stem>` file), exactly like today's single extract. No merged folder. True "extract here" / smart extract = product policy → NOT in R1 (escalated to main).
3. **Non-archives in selection.** Skipped. Toast once: "압축 파일이 아닌 n개는 건너뜀" with names in detail. Remote-unsupported archives (7z/rar on ssh) count as skipped with the remote reason, not silently dropped.
4. **Collisions** (deterministic, decided in BE, tested):
   - a. `<stem>` already exists on disk (archive-21): ask once per batch in a dialog listing the names. Choices:
     **Replace** (existing moved to `.bak` via current rule — Ctrl+Z restores, unchanged BE behaviour) /
     **Keep both** (extract into first free `stem (2)`, `stem (3)`… via BE) / **Cancel** (nothing runs).
     Single-archive extract gets the same dialog (fixes archive-21).
   - b. Two archives in one batch with the same stem (`a.zip` + `a.tar.gz`): never let one batch item back up / overwrite another batch item's output. BE plans the batch and gives later duplicates `a (2)` etc. regardless of the a-choice. Order = selection order as listed.
   - Naming of `stem (n)` must be done in Rust (`Path`/`fs.join`, §7); reuse the existing KeepBoth unique-name helper in core if it is `pub(crate)`; do NOT edit `core/ops.rs` (fileops-owned) — if a change there is needed, stop and tell the lead.
5. **IPC.** Proposed: `fs_extract_plan_batch(archives: Vec<EntryRef>, keep_both: bool) -> Vec<ExtractPlanItem>` where each item is `{ archive: EntryRef, plan: Option<ExtractPlan>, error: Option<DuetError> }` (per-item error so one bad archive does not fail the batch). Existing `fs_extract_plan` stays (double-click/browse untouched). `fs_extract_execute` unchanged — each archive is its own task → its own journal entry / undo step (§4). Run `pnpm gen:bindings`.
   Execute must re-check: if a plan's `dest_dir` now exists and the user chose Keep both, the BE still backs it up (existing rule) — acceptable, undoable; document.
6. **Password.** Each encrypted archive's task fails NeedPassword → one prompt per archive, FIFO queue (today the single `extract-password` dialog slot would be overwritten). Dialog shows which archive. Cancel skips only that archive and opens the next. No reuse of a password across archives in R1 (no opt-in UI). Password stays in component local state only (§5).
7. **Partial failure.** Plan errors and execute (task) errors don't stop other archives. After the batch is dispatched, show ONE summary toast if any failed at plan/dispatch stage: "n개 압축 해제 실패: a.zip, b.tar" (detail = per-item reasons). Task-time failures keep the existing per-task error path (TasksBar/toast) — document this split.
8. **Code ownership.** New FE module `src/lib/extractActions.ts` (archive-owned) holds `triggerExtract`. `src/lib/fileActions.ts` hunk = delete old `triggerExtract` + its import only (fileops lead agreed). Password queue lives in `src/lib/extractPending.ts` + `useTaskEvents.ts` NeedPassword branch + the `extract-password` dialog close path in `App.tsx` **only that dialog block** (~L2251-2270; shell edits App.tsx L758-830 — don't touch). i18n: only `menu.extract*`, `toast.extract*`, `dialog`-keys for the new conflict dialog.

## Tests (required)

- Rust (core, real temp dirs, no user paths): batch plan with `a.zip`+`a.tar.gz` → distinct dests; existing `a/` + keep_both → `a (2)`; existing + replace → conflict flagged, execute backs up, undo restores; one corrupt/unsupported item → per-item error, others planned; remote-unsupported in batch → per-item error.
- End-to-end core smoke: plan batch of 3 real archives (zip, tar.gz, single .gz) + execute each → contents correct, 3 journal entries.
- Vitest: menu item label/visibility for single / multi-all-archives / mixed / no-archives / remote 7z; `triggerExtract` with mocked commands: skipped-non-archive toast, conflict dialog opens, Cancel runs nothing, Keep both replans with keep_both=true, one plan error → summary toast + others executed; password queue FIFO + cancel skips one.
- Focused runs only: `CARGO_BUILD_JOBS=2 cargo test --lib archive`, the new integration test file, `pnpm exec vitest run <files>`, `pnpm exec tsc --noEmit`, `pnpm lint` on touched files, `cargo clippy` deferred to lead (serialised). Never pipe vitest into tail (exit code).

## Not in R1 (record as limits)

- True "extract here"/smart extract (product decision, escalated).
- Command palette / shortcut for extract (registry is shell-owned).
- Password reuse across archives.
- Cancel/rollback semantics of running extract (G-09, archive-14).

## Addendum A — AR-05 palette commands (contract from ux-shell-lead)

- `src/lib/commands.ts`: add BuiltinDeps callbacks + two entries `file.extract` and `file.compress`, category `File`, **no defaultKey**, inserted right after the `file.calcSize` entry.
- Wire the deps in `App.tsx` where the other builtin deps are passed (NOT the More-options blocks L758-830).
- i18n `cmd.file.extract` / `cmd.file.compress` in BOTH ko and en (key-parity test).
- Menu items `extract`/`compress` in entryMenu get `commandId` so the palette and menu agree.
- Tests: `src/lib/commands.*.test.ts` + keymap tests. Separate commit (`fe/ui: add extract and compress commands`).
