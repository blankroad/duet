# Round 2 — focused frontend reproductions

Base 76b9b6e; all evidence here is **FE-MOCK**, never live-app/native/real SSH. Tests assert desired behavior with ordinary `it` (no it.fails), so assertion failures on base are the repro. No product changes or commits. Cargo/gen:bindings/build remained frozen.

Setup: `pnpm install --frozen-lockfile --offline` exited 0 (575 packages, no fallback needed); copied base gitignored bindings using `cp /Users/ctmctm/Desktop/01_PROJECT/duet/src/types/bindings.ts src/types/bindings.ts`. Only individual Vitest files were run. Mocked errors prevent real task execution/filesystem/server use.

| ID | Test file (repository-relative) | Exact command | Output summary / verdict |
| --- | --- | --- | --- |
| UX-SHL-07 | src/__ux_research__/shl07-edit-command.test.ts | `pnpm exec vitest run src/__ux_research__/shl07-edit-command.test.ts` | Exit 1; Test Files 1 failed (1), Tests 1 failed (1). `F4 editor command must be registered: expected undefined to be defined`. **REPRODUCED (FE-MOCK)**. Actual buildBuiltins invoked with editor spy, no F4 command returned. |
| UX-BRW-01 | src/__ux_research__/brw01-bookmark.test.ts | `pnpm exec vitest run src/__ux_research__/brw01-bookmark.test.ts` | Exit 1; Test Files 1 failed (1), Tests 1 failed (1). `expected [ '/fixture/alpha' ] to deeply equal [ '/fixture/alpha', '/fixture/beta' ]`. **REPRODUCED (FE-MOCK)**. Actual menu builder, two selected folders, clicked alpha; mocked bookmarkLocation received alpha only. |
| UX-REM-02 | src/__ux_research__/rem02-restored-toolbar.test.tsx | `pnpm exec vitest run src/__ux_research__/rem02-restored-toolbar.test.tsx` | Exit 1; Test Files 1 failed (1), Tests 3 failed (3). Copy, Move, Delete each: `expected "spy" to not be called at all, but actually been called 1 times`. **REPRODUCED (FE-MOCK)**. Real toolbar + shared fileActions; mocked fsCopyPlan/fsMovePlan/fsDeletePlan each received source connection_id `prod:restored`, path `/srv`, target `a.txt`. Controls assert isRestoredRemote true; no active connection. Does not test backend failure or create submission. |
| UX-SHL-08 | src/__ux_research__/shl08-macos-quit.test.ts | `pnpm exec vitest run src/__ux_research__/shl08-macos-quit.test.ts` | Exit 1; Test Files 1 failed (1), Tests 1 failed / 1 passed (2). Windows control passes; Macintosh: `available Quit must perform a window action: expected "spy" to be called once, but got 0 times`. **REPRODUCED (FE-MOCK, isolated production callback)**. See isolation limit below. |
| UX-FOP-01 | src/__ux_research__/fop01-trash-toolbar.test.tsx | `pnpm exec vitest run src/__ux_research__/fop01-trash-toolbar.test.tsx` | Exit 1; Test Files 1 failed (1), Tests 2 failed (2). Copy and Move: `expected false to be true // Object.is equality` for button.disabled. **REPRODUCED (FE-MOCK)**. Control New folder.disabled is true. Real PaneToolbar with action spies; tests enabled state, not shell Recycle Bin operations. |
| UX-FOP-02 | src/__ux_research__/fop02-empty-delete.test.ts | `pnpm exec vitest run src/__ux_research__/fop02-empty-delete.test.ts` | Exit 1; Test Files 1 failed (1), Tests 1 failed (1). `empty selection needs user feedback: expected "spy" to be called at least once`. **REPRODUCED (FE-MOCK)**. Real shared trigger resolves empty targets; plan and dialog control assertions pass; toast is never called. |

## Interpretation and limits

- UX-SHL-08 extracts the **actual** `quit` arrow from App.tsx's buildBuiltins argument with TypeScript AST, transpiles it, and substitutes only its dynamic Tauri window import with a Promise returning a window mock. Final version wires that callback through actual buildBuiltins, asserts app.quit exists, and invokes its action. Macintosh userAgent is the production gate; Windows control exercises mock import/close. This is isolated-callback FE-MOCK evidence, **not** App rendering, macOS WebView, or native quit verification. No copied/reimplemented quit branch or source-text assertion substitutes for callback execution.
- UX-BRW-01 tests a policy of handling all selected folders **or** hiding/disabling the action; it does not demand batch bookmarking as the only fix. An enabled action currently handles only alpha with no selection-count explanation. The test mocks persistence, so it proves arguments, not saved-bookmark disk state.
- UX-REM-02 proves forbidden dead-source command dispatch from Copy/Move/Delete clicks. No claim that the backend performs an operation, crashes, or contacts a server. Mock plans return a structured disconnected error before execution.
- UX-FOP-01 proves button enabled state only; shared actions in production already reject virtual trash with feedback. Thus this is UI availability consistency, not an unsafe operation.
- UX-FOP-02 is the shared action's feedback contract on a genuinely empty target set, not a claim that clearing selected names with a valid cursor should delete nothing.
- All test files intentionally fail desired-behavior assertions on base and are uncommitted research artifacts. Suite exits 1 are expected repro outcomes, not new product changes.

## Harness corrections / reruns

Initial UX-SHL-08 collection failed with `TypeError: The URL must be of scheme file` (0 tests): jsdom/Vite import.meta.url was unsuitable for Node readFileSync. This was a **harness error, not product evidence**. Corrected to read source under process.cwd; rerun executed tests with Windows passing and Macintosh failing. Final registry-wiring rerun is recorded in the result table. UX-BRW-01 rerun after TypeScript union narrowing retained exactly the same expected-vs-received failure.

Some store-importing tests emitted Node's `--localstorage-file was provided without a valid path` warning; tests collected and reached the intended assertions. No dependency fallback, cargo invocation, gen:bindings, build, full test suite, live OS integration or server operation occurred.

Final focused runs: **6 files, 10 tests: 9 desired-behavior assertion failures, 1 Windows control pass; all 6 candidate IDs REPRODUCED (FE-MOCK)**. No final-run collection errors. Report and src/__ux_research__/ remain untracked; tracked product diff is empty.
