# `types/` — 타입 정의

## 책임

- 백엔드와 공유하는 IPC 타입
- 프론트엔드 전용 타입 (UI 상태 등)

## 백엔드 타입 동기화

`ts-rs` crate 사용해서 Rust 구조체에서 자동 생성 권장:

```rust
// src-tauri/src/commands/pane.rs
#[derive(Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/ipc/")]
pub struct ListResult {
    pub entries: Vec<Entry>,
    pub error: Option<String>,
}
```

빌드 시 자동으로 `src/types/ipc/ListResult.ts` 생성.

## 구조

```
types/
├── ipc/             # ts-rs 자동 생성 (커밋함, 빌드 결과)
│   ├── Entry.ts
│   ├── Location.ts
│   ├── ListResult.ts
│   └── ...
├── commands.ts      # Command 이름 → 입력/출력 매핑
└── ui.ts            # 프론트 전용 (모달, 다이얼로그 상태)
```

## Command 매핑 패턴

```ts
// commands.ts — 타입 안전 invoke를 위한 매핑
import type { Entry } from "./ipc/Entry";
import type { Location } from "./ipc/Location";

export interface Commands {
  pane_navigate: {
    input: { pane: PaneId; location: Location };
    output: { entries: Entry[] };
  };
  fs_copy: {
    input: { src: EntryRef[]; dst: Location };
    output: { taskId: string };
  };
  // ...
}
```

이걸 `useTauri.ts` 의 제네릭과 결합하면 IDE에서 자동완성 + 타입 체크.

## 하지 말 것

- ❌ ts-rs 생성 파일 직접 수정 (빌드 시 덮어씀)
- ❌ 백엔드와 다른 타입 정의 (단일 진실 공급원)
