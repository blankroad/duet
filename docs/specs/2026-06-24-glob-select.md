# 패턴 선택 (glob-select) — 설계

> 2026-06-24. 현재 패널 항목 중 glob/부분문자열 패턴에 맞는 것들을 한 번에
> 선택/해제. TC 의 `+`/`-` (Ctrl+Gray+) 선택과 동일 계열.

**상태**: 설계 (벤치마킹 후속 #1). 프론트 전용, IPC 변경 없음.

## 문제

현재 선택은 마우스(클릭/Ctrl/Shift/마키)와 키보드(`Ctrl+Space`)로 **단건·범위**만
가능. `Ctrl+F` 빠른 필터는 *표시*를 좁힐 뿐 선택 액션이 아니다. "`*.jpg` 전부 선택" 같은
배치 선택 경로가 없어 다중 작업(복사/이동/압축/삭제) 전 단계가 번거롭다.

## 합의된 동작 (UX)

- **선택 추가**: 키 → 작은 입력창("패턴: ") → Enter → 매칭 항목을 **선택집합에 추가**.
- **선택 해제**: 다른 키 → 같은 입력창 → 매칭 항목을 **선택집합에서 제거**.
- 패턴 문법: glob (`*`, `?`, `[abc]`) **또는** 부분문자열(특수문자 없으면 substring 취급).
  대소문자 무시 기본.
- 대상은 **현재 `displayedEntries`** (필터/숨김/정렬 반영분). `..` 부모 항목 제외.
- 매칭 0건이면 토스트("일치 항목 없음"), 선택 변화 없음.

### 키 (기본값, 재바인딩 가능)

| command id | 기본 키 | 동작 |
|---|---|---|
| `select.byPattern` | `Ctrl+=` | 패턴 매칭 항목 선택 추가 |
| `select.removeByPattern` | `Ctrl+-` | 패턴 매칭 항목 선택 해제 |

> `lib/commands.ts` 의 command 목록에 두 항목 추가. macOS 는 자동 `Cmd` 매핑.
> 입력창은 `PaneFilterBar` 를 재활용한 경량 인라인 바(활성 패널 상단).

## 프론트엔드

레이어: **프론트 전용.** 백엔드/IPC 변경 없음.

- `lib/glob.ts` (신규, 작은 헬퍼):
  ```ts
  // glob → RegExp. 특수문자(* ? [ ])가 없으면 substring 매칭으로 폴백.
  export function patternToMatcher(pattern: string): (name: string) => boolean
  ```
  - `*`→`.*`, `?`→`.`, `[...]` 통과, 그 외 정규식 메타는 escape. `i` 플래그.
  - 단위 테스트(`glob.test.ts`): `*.ts`, `img_??.png`, `report` (substring), `[abc]*`.
- `stores/panes.ts` 액션 추가:
  ```ts
  selectByPattern(paneId: PaneId, pattern: string, mode: "add" | "remove"): void
  ```
  - `displayedEntries` (기존 selector) 순회 → matcher 적용 → 선택집합(name 기준) 갱신.
  - `..` 및 매칭 외 항목은 불변. 커서 위치는 유지.
- `components/pane/SelectPatternBar.tsx` (신규, `PaneFilterBar` 패턴 복제): 인라인 입력,
  Enter=적용, Esc=닫기. 진입 시 직전 패턴 prefill.
- 키 핸들러: `hooks/useKeyboardNav.ts`(또는 `useGlobalShortcuts.ts`)에서 두 command 를
  바 오픈으로 연결. 팔레트(`Ctrl+P`)에서도 실행 가능(입력창 뜸).

## 엣지/에러

- 빈 패턴 → 무시(바만 닫음).
- 필터(`Ctrl+F`) 활성 중에도 동작 — 대상은 항상 현재 표시분.
- 그리드/타일/디테일 뷰 모두 동일(선택집합은 뷰 무관).

## 범위 밖 (후속)

- 정규식 모드 토글, 저장된 패턴 프리셋.
- 크기/날짜/속성 조건 선택(예: `size>100MB`) — TC WDX 류.
- 선택 반전(invert) / 전체 선택 토글은 별도 command 로(이미 있으면 재활용).
