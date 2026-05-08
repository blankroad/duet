# `core/` — 도메인 로직

## 책임

OS / 프로토콜 독립적인 로직. 가장 많은 단위 테스트가 있어야 할 곳.

- 정렬, 필터링, 검색
- `DeleteOp`, `CopyOp`, `MoveOp` trait — dry-run + execute 패턴
- 같은 호스트 감지 (`CopyStrategy` 결정)
- 충돌 정책 (덮어쓰기 → backup 파일 생성)
- `Confirmed` 토큰 (사용자 확인 거친 작업만 실행)
- 사이즈 / 시간 포맷팅

## 의존성

- 위로: 없음
- 아래로: `fs/` (FileSystem trait 사용)
- 외부: 표준 라이브러리 위주, `chrono`, `serde`

## 하지 말 것

- ❌ Tauri / 화면 관련 코드
- ❌ `std::fs` 직접 (반드시 `fs::FileSystem` 통해서)
- ❌ OS별 분기 (그건 `platform/`)
- ❌ SSH 직접 (그건 `ssh/`)

## 핵심 trait

```rust
pub trait DeleteOp {
    async fn plan(&self) -> Result<DeletePlan, DuetError>;
    async fn execute(
        &self,
        plan: DeletePlan,
        confirmed: Confirmed,
    ) -> Result<JournalEntry, DuetError>;
}

/// private constructor — 사용자 확인 거친 후에만 발급
pub struct Confirmed(());

impl Confirmed {
    /// services/notifier 또는 commands 만 호출 가능 (모듈 가시성으로 제한)
    pub(crate) fn new() -> Self { Self(()) }
}
```

## 같은 호스트 복사 (핵심 가치)

```rust
pub fn determine_strategy(
    src: &dyn FileSystem,
    dst: &dyn FileSystem,
) -> CopyStrategy {
    if src.source_id() == dst.source_id() {
        CopyStrategy::DirectOnHost
    } else if src.supports_local_copy(dst) {
        CopyStrategy::ServerToServer
    } else {
        CopyStrategy::Relay
    }
}
```

`Relay` 폴백은 디폴트로 사용 안 함. 사용자가 옵션으로 켜야만.

## 서브 모듈

```
core/
├── mod.rs
├── ops.rs           # DeleteOp, CopyOp, MoveOp trait + Confirmed
├── strategy.rs      # CopyStrategy 결정
├── plan.rs          # 작업 계획 (dry-run 결과)
├── conflict.rs      # 충돌 처리 (덮어쓰기 → backup)
├── sort.rs
├── filter.rs
└── format.rs        # 사이즈/시간 포맷
```
