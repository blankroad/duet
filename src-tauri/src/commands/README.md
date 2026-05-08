# `commands/` — Tauri IPC 진입점

## 책임

- 프론트엔드 ↔ 백엔드 IPC 명세 (Tauri `#[tauri::command]`)
- 입력 검증 (sandbox 검사, 경로 정규화)
- `services/` 호출, 결과를 직렬화 가능한 타입으로 변환
- 에러를 `DuetError` 로 통일해서 반환

## 의존성

- 위로: 없음 (가장 상위)
- 아래로: `services/`
- 외부: `tauri`, `serde`

## 하지 말 것

- ❌ 비즈니스 로직 (그건 `services/` 또는 `core/`)
- ❌ 직접 fs/ssh 호출 (services 통해서)
- ❌ 자격증명 / 비밀번호를 응답에 포함 (절대)
- ❌ 무한 대기 작업 (long-running은 task ID 반환하고 즉시 리턴)

## 명세

자세한 IPC 명세는 `ARCHITECTURE.md` 의 "IPC 경계" 섹션 참조.

```rust
// 예시: pane/list_directory
#[tauri::command]
pub async fn list_directory(
    state: tauri::State<'_, AppState>,
    pane: PaneId,
    location: Location,
) -> Result<ListResult, DuetError> {
    // 1. sandbox 검사 (개발 모드)
    state.sandbox.check(&location)?;

    // 2. services 호출
    let entries = state.services.fs.list(&location).await?;

    // 3. 응답
    Ok(ListResult { entries, ... })
}
```

## 서브 모듈

```
commands/
├── mod.rs
├── connection.rs    # SSH 연결 관리
├── pane.rs          # 패널 / 디렉토리 리스팅
├── fs.rs            # 파일 작업 (copy/move/delete)
├── task.rs          # 작업 큐 조회/취소
├── undo.rs          # undo 시스템
└── config.rs        # 설정
```
