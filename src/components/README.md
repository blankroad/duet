# `components/` — React 컴포넌트

## 책임

- 화면 렌더링
- 사용자 입력 받기 → store action 또는 Tauri command 호출
- 시각적 상태 표시 (선택, 로딩, 에러)

## 의존성

- 위로: `App.tsx` 가 import
- 아래로: `stores/`, `hooks/`, `lib/`
- `components/ui/` 는 shadcn/ui (생성된 코드, 직접 수정 OK)

## 하지 말 것

- ❌ Tauri command 직접 호출 — `hooks/useTauri.ts` 통해서
- ❌ 비즈니스 로직 — store / hook 으로
- ❌ 인라인 스타일 (`style={{...}}`) — Tailwind 클래스만
- ❌ 색상 하드코딩 — CSS variable / Tailwind 토큰

## 구조

```
components/
├── ui/                  # shadcn/ui (Button, Dialog, Input 등)
├── pane/                # 듀얼 패널 메인
│   ├── Pane.tsx
│   ├── EntryList.tsx    # 가상 스크롤 적용
│   ├── EntryRow.tsx
│   └── PathBar.tsx
├── connection/          # SSH 연결
│   ├── ConnectionList.tsx
│   └── ConnectionDialog.tsx
├── dialog/              # 모달 다이얼로그
│   ├── ConfirmDialog.tsx
│   ├── DangerConfirmDialog.tsx  # 영구 삭제 (단어 타이핑)
│   ├── PromptDialog.tsx
│   └── ProgressDialog.tsx
├── statusbar/
│   ├── StatusBar.tsx
│   └── TaskList.tsx
├── sidebar/
│   └── Sidebar.tsx
└── command-palette/
    └── CommandPalette.tsx
```

## 패턴

```tsx
// 컴포넌트는 함수형, props 타입 명시
interface PaneProps {
  id: PaneId;
}

export function Pane({ id }: PaneProps) {
  const { entries, cursor, ... } = usePane(id);
  // ...
  return <div className="...">...</div>;
}
```
