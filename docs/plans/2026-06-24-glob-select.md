# 패턴 선택 (glob-select) — 실행 plan

> spec: `docs/specs/2026-06-24-glob-select.md`. 프론트 전용, IPC 변경 없음.

## 작업 순서

1. **`src/lib/glob.ts`** — `patternToMatcher(pattern) => (name) => boolean`.
   glob 메타(`* ? [ ]`) 있으면 RegExp, 없으면 substring. 항상 case-insensitive.
   - `src/lib/glob.test.ts` — `*.ts`, `img_??.png`, `report`(substring), `[abc]*`, 빈 패턴.
2. **`src/stores/panes.ts`** — `selectByPattern(id, pattern, mode: "add"|"remove")`.
   `computeDisplayed(active tab)` 대상, `..` 제외, 선택집합(name) 갱신.
3. **`src/stores/ui.ts`** — `requestSelectPattern(pane, mode)` + `selectPatternPane` /
   `selectPatternMode` / `selectPatternNonce` (editPath 패턴 동일).
4. **`src/components/pane/SelectPatternBar.tsx`** — `PaneFilterBar` 복제. nonce 변화 +
   pane 일치 시 열림/포커스, Enter=적용+닫기, Esc=닫기. add/remove 라벨.
5. **`src/components/pane/Pane.tsx`** — `<PaneFilterBar>` 아래에 `<SelectPatternBar>`.
6. **`src/lib/commands.ts`** — `select.byPattern`(Ctrl+=) / `select.removeByPattern`
   (Ctrl+-) 추가, `BuiltinDeps` 에 `selectByPattern` / `deselectByPattern` 콜백.
7. **`src/App.tsx`** — deps 주입: `() => useUI.getState().requestSelectPattern(activePane, "add"|"remove")`.

## 검증

- `pnpm test` (glob.test.ts 포함), `pnpm lint`, `tsc` (build).
- 수동: 패널에서 `Ctrl+=` → `*.ts` → Enter → .ts 선택됨. `Ctrl+-` → 일부 해제.

## 범위 밖

정규식 모드, 패턴 프리셋, size/date 조건 — spec "범위 밖" 동일.
