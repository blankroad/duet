# `lib/` — 유틸리티

## 책임

- Tauri command 래퍼
- 포맷팅 (사이즈, 시간, 경로)
- 아이콘 매핑 (파일 타입 → lucide 아이콘)
- 클래스 합성 (`cn()` from clsx + tailwind-merge)

## 구조

```
lib/
├── tauri.ts         # call<T>() 래퍼, event 구독
├── format.ts        # formatSize(), formatDate(), formatPath()
├── icons.ts         # iconForEntry(entry) → IconComponent
├── cn.ts            # cn() = clsx + tailwind-merge
└── keys.ts          # 키 조합 파싱 ("Ctrl+C" → KeyBinding)
```

## 예시

```ts
// cn.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// format.ts
export function formatSize(bytes: number): string {
  // "1.2 MB", "523 KB" 등
}

// icons.ts
export function iconForEntry(entry: Entry) {
  if (entry.kind === "Dir") return Folder;
  // ...
}
```

## 하지 말 것

- ❌ 비즈니스 로직 — utility 만
- ❌ React hooks (그건 `hooks/`)
