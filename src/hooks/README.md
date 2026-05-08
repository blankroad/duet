# `hooks/` — Custom React hooks

## 책임

- Tauri command 호출 추상화
- 이벤트 구독
- 키보드 단축키 매핑
- 선택 / 클립보드 / 드래그앤드롭 로직

## 구조

```
hooks/
├── useTauri.ts          # invoke<T>() 래퍼 (타입 안전)
├── useTauriEvent.ts     # event 구독 훅
├── useKeyboard.ts       # 글로벌 키 바인딩
├── useSelection.ts      # 다중 선택 로직
├── useTheme.ts          # 다크/라이트 모드
└── useClipboard.ts      # 복사/붙여넣기 큐
```

## 패턴

```ts
// useTauri.ts — 타입 안전 래퍼
import { invoke } from "@tauri-apps/api/core";
import type { Commands } from "@/types/ipc";

export async function call<K extends keyof Commands>(
  name: K,
  args: Commands[K]["input"],
): Promise<Commands[K]["output"]> {
  return invoke(name, args as Record<string, unknown>);
}

// 사용:
const result = await call("pane_navigate", { pane: "left", location });
```

## 하지 말 것

- ❌ 컴포넌트 안에서 `invoke` 직접 호출 — 항상 hook/store 통해서
- ❌ 에러 처리 누락 — Tauri command는 거부될 수 있음
