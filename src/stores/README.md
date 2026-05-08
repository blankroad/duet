# `stores/` — Zustand 상태 스토어

## 책임

- 프론트엔드 상태 관리
- 패널, 연결, 작업, 설정 등
- 백엔드 이벤트를 받아 상태 업데이트
- 컴포넌트에서 selector로 사용

## 구조

```
stores/
├── panes.ts         # 좌/우 패널 (디렉토리, 커서, 선택)
├── connections.ts   # SSH 연결 풀 (백엔드 미러)
├── tasks.ts         # 작업 큐 (백엔드 이벤트 구독)
├── config.ts        # 사용자 설정
└── ui.ts            # 모달 표시, 활성 패널 등
```

## 패턴

```ts
import { create } from "zustand";

interface PanesState {
  active: PaneId;
  left: PaneState;
  right: PaneState;
  setActive: (id: PaneId) => void;
  navigate: (id: PaneId, location: Location) => Promise<void>;
}

export const usePanes = create<PanesState>((set, get) => ({
  active: "left",
  left: { ... },
  right: { ... },
  setActive: (id) => set({ active: id }),
  navigate: async (id, location) => {
    const result = await invoke("pane_navigate", { pane: id, location });
    set((state) => ({
      [id]: { ...state[id], entries: result.entries }
    }));
  },
}));
```

## 하지 말 것

- ❌ React 외부에서 store 변경 (cross-tab 등) — 한 윈도우 가정
- ❌ store 안에서 다른 store 직접 import (순환 위험)
- ❌ 백엔드 응답을 그대로 저장 — 필요한 부분만 selector
