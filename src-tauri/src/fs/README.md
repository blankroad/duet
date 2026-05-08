# `fs/` — Filesystem 추상화

## 책임

- `FileSystem` trait — 모든 파일 I/O의 인터페이스
- `LocalFs` — 로컬 파일시스템 (`tokio::fs`)
- `SshFs` — SSH/SFTP (`ssh/` 모듈 활용)
- `MockFs` — 테스트용 인메모리
- `Entry`, `Metadata` 등 파일 표현 타입
- 파일 변경 감지 (`notify`)

## 의존성

- 위로: 없음
- 아래로: `ssh/`, `platform/`
- 외부: `tokio`, `notify`, `trash`

## 하지 말 것

- ❌ Tauri 호출 (이 레이어는 IPC 모름)
- ❌ 정렬/필터링 (그건 `core/`)
- ❌ 사용자 설정 읽기 (그건 `services/config`)
- ❌ 직접 OS API (반드시 `platform/` 통해서)

## 핵심 trait

```rust
#[async_trait]
pub trait FileSystem: Send + Sync {
    fn source_id(&self) -> SourceId;

    async fn list(&self, path: &Path) -> Result<Vec<Entry>>;
    async fn metadata(&self, path: &Path) -> Result<Metadata>;
    async fn read(&self, path: &Path, range: Option<Range<u64>>) -> Result<Bytes>;

    async fn copy(&self, from: &Path, to: &Path, opts: CopyOpts) -> TaskHandle;
    async fn rename(&self, from: &Path, to: &Path) -> Result<()>;
    async fn mkdir(&self, path: &Path) -> Result<()>;
    async fn trash(&self, path: &Path) -> Result<()>;
    async fn remove(&self, path: &Path) -> Result<()>;  // 영구 삭제

    fn supports_local_copy(&self, other: &dyn FileSystem) -> bool;
    async fn local_copy(
        &self,
        from: &Path,
        to: &Path,
        other: &dyn FileSystem,
    ) -> Result<TaskHandle>;
}
```

## SourceId

```rust
pub enum SourceId {
    Local,
    Ssh { host: String, user: String },
}

// 같은 호스트 감지: SourceId == 비교
// 단, ProxyJump 통해 같은 백엔드 호스트면 같은 SourceId 부여
```

## 서브 모듈

```
fs/
├── mod.rs
├── traits.rs        # FileSystem trait
├── entry.rs         # Entry, Metadata, SourceId
├── local.rs         # LocalFs
├── ssh.rs           # SshFs (ssh/ 모듈 활용)
├── mock.rs          # MockFs (테스트)
└── watch.rs         # notify 통합
```

## 테스트

`MockFs` 로 단위 테스트 필수. 실제 파일시스템 건드리는 통합 테스트는
`tests/` 에 별도 + `tempfile::TempDir`.
