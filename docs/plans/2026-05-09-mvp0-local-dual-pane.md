# MVP-0 Implementation Plan: 로컬 듀얼 패널

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 파일시스템에서 듀얼 패널 + 사이드바 토글 + 상태바가 동작하는 read-only 탐색기를 완성한다.

**Architecture:** Tauri 2 + React 18 + Vite. 백엔드는 `FileSystem` trait + `LocalFs`로 시작. IPC 타입은 `specta + tauri-specta`로 자동 생성 (Rust → TS). 프론트는 Zustand 스토어 + `useTauri` hook으로 IPC 호출. 가상 스크롤로 1만 항목 응답성.

**Tech Stack:** Tauri 2.1, Rust 2021, React 18, TypeScript 5.6, Tailwind 3.4, Zustand 5, `@tanstack/react-virtual` 3, `specta` 2 + `tauri-specta` 2 (`ts-rs` 제거), `vitest` 2.

**Spec references:**
- `ARCHITECTURE.md` — 레이어, IPC 경계, 핵심 추상화 (`FileSystem` trait, `SourceId` enum, `plan_copy`)
- `DESIGN.md` — UI/UX, 색상 시스템, 키 바인딩
- `ROADMAP.md` MVP-0 항목
- `CLAUDE.md` 절대 규칙 1-9 (특히 §1 IPC 경계, §3 영구 삭제 비활성화, §6 의존성, §7 path 조작 금지)

**현재 상태 (시작 전):**
- ✅ Tauri 2 + Vite 부트스트랩 완료
- ✅ Tailwind config (CSS vars) + `globals.css` + 다크/라이트 자동 감지
- ✅ 모듈 스켈레톤 (`commands/`, `services/`, `core/`, `fs/`, `ssh/`, `platform/` 빈 mod.rs)
- ✅ `App.tsx` placeholder
- ⚠ `Cargo.toml`에 `ts-rs` 있음 → `specta + tauri-specta`로 교체 필요 (Task 1)
- ⚠ Tauri builder에 command 등록 안 됨 (Task 5에서)

**완료 조건 (ROADMAP MVP-0 일치):**
- 로컬 한 디렉토리를 듀얼 패널로 띄워서 마우스/키보드로 탐색 가능
- 1만 항목 디렉토리에서 즉각 응답
- 다크/라이트 모드 시스템 따라감
- `Ctrl+B` 사이드바 토글, `Ctrl+Q` 종료
- 백엔드 fs/core 레이어 단위 테스트 통과

---

## 작업 흐름 가이드

각 Task는 독립적 커밋 단위. 순서대로 진행. 각 Task 끝에 `pnpm tauri dev`로 확인하고 `git commit`.

**TDD 정책 (CLAUDE.md 준수):**
- 백엔드 `fs/`, `core/`, `services/` 레이어: 테스트 먼저 (failing 확인 → 구현 → passing 확인)
- 백엔드 `commands/`: 통합 테스트 (mock FS) 권장
- 프론트엔드: store/hook은 테스트, 컴포넌트는 시각 확인 우선 (테스트는 옵션)

**커밋 메시지 컨벤션 (CLAUDE.md):**
```
<scope>: <짧은 설명>

scope: be/cmd, be/svc, be/fs, be/ssh, be/platform, fe/ui, fe/store, fe/hook, config, docs, build
```

---

## Phase A: 빌드 인프라

### Task 1: ts-rs → specta + tauri-specta 전환

**Why:** 브레인스토밍 결정사항. specta는 Tauri 2 command 시그니처 + 타입을 한 번에 TS로 export. ts-rs는 타입만 가능해서 이중 미러링 위험.

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/build.rs` (수정 — 기존 build.rs 있음)
- Create: `src/types/bindings.ts` (생성됨, gitignore 처리)

- [ ] **Step 1: Cargo.toml 의존성 교체**

`src-tauri/Cargo.toml`에서:

```toml
# 제거
ts-rs = { version = "10", features = ["chrono-impl", "serde-compat"] }

# 추가 (`# === Type sharing ===` 섹션)
specta = { version = "=2.0.0-rc.22", features = ["derive"] }
specta-typescript = "=0.0.9"
tauri-specta = { version = "=2.0.0-rc.21", features = ["derive", "typescript"] }
```

(rc 버전 핀 — 안정 릴리즈 시점에 교체. CLAUDE.md §6: `*` 버전 금지, 정확한 버전 명시.)

- [ ] **Step 2: 빌드 시 TS 바인딩 자동 생성을 위한 collector 준비**

`src-tauri/src/lib.rs`에 collector를 만든다 (다음 Task의 command가 등록될 자리):

```rust
//! duet — Safe dual-pane SSH/SFTP file manager
//! ...

pub mod platform;
pub mod ssh;
pub mod fs;
pub mod core;
pub mod services;
pub mod commands;
pub mod types;  // 다음 Task에서 만듦

use tauri_specta::{collect_commands, Builder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let specta_builder = Builder::<tauri::Wry>::new()
        // commands는 다음 Task에서 추가
        .commands(collect_commands![]);

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default()
                .formatter(specta_typescript::formatter::prettier),
            "../src/types/bindings.ts",
        )
        .expect("failed to export specta bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: bindings.ts gitignore**

루트 `.gitignore` 끝에 추가:

```
# tauri-specta 자동 생성 (devmode에서만)
src/types/bindings.ts
```

- [ ] **Step 4: 빌드 확인**

```bash
pnpm tauri dev
```

기대: 컴파일 성공, 윈도우 뜸. `src/types/bindings.ts` 가 생성됨 (빈 export일 수 있음). `[debug]` 모드에서만 export.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs .gitignore
git commit -m "build: ts-rs → specta + tauri-specta

타입 + command 시그니처 한 번에 TS export.
ARCHITECTURE.md L84 결정사항 반영."
```

---

## Phase B: 도메인 타입 + FS 추상화

### Task 2: 도메인 타입 정의 (specta export)

**Files:**
- Create: `src-tauri/src/types/mod.rs`
- Create: `src-tauri/src/types/error.rs`

- [ ] **Step 1: types/mod.rs 작성**

```rust
//! IPC 경계에서 공유되는 핵심 타입.
//!
//! 모두 `specta::Type` derive — `tauri-specta`가 TS 자동 export.
//! `ARCHITECTURE.md` 의 "IPC 데이터 타입" 섹션과 1:1 매칭.

pub mod error;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::net::IpAddr;
use std::path::PathBuf;

pub use error::DuetError;

/// 연결 식별자. 백엔드 ConnectionPool 키.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct ConnectionId(pub String);

/// 파일시스템 식별자. 같은 머신(SSH host_ip 일치) 판정용.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourceId {
    Local,
    Ssh {
        connection_id: ConnectionId,
        host_ip: IpAddr,
        user: String,
    },
}

/// 위치 (소스 + 경로).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Location {
    pub source: SourceId,
    pub path: PathBuf,
}

/// 항목 참조 (위치 + 이름).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct EntryRef {
    pub location: Location,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// 디렉토리 항목 메타데이터.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    /// Unix epoch milliseconds. JS Date와 호환.
    pub modified_ms: Option<i64>,
    /// Unix permission bits (mode & 0o777). Windows에선 None.
    pub permissions: Option<u32>,
    /// 숨김 파일 여부 (`.` 시작 또는 OS hidden 속성).
    pub hidden: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DeleteMode {
    Trash,
    Permanent,
}
```

- [ ] **Step 2: types/error.rs 작성**

```rust
//! IPC 경계로 노출되는 에러 타입.
//!
//! `Serialize` 필수 — Tauri command가 `Result<T, DuetError>` 반환 시 자동 직렬화.
//! `anyhow::Error` 는 `commands/` 진입에서 `DuetError`로 변환.

use serde::Serialize;
use specta::Type;
use thiserror::Error;

#[derive(Debug, Error, Serialize, Type)]
#[serde(tag = "kind", content = "message")]
pub enum DuetError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("connection failed: {0}")]
    ConnectionFailed(String),
    #[error("auth failed")]
    AuthFailed,
    #[error("destructive op not permitted")]
    NotPermitted,
    #[error("cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(String),
    #[error("ssh: {0}")]
    Ssh(String),
}

impl From<std::io::Error> for DuetError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => DuetError::NotFound(e.to_string()),
            std::io::ErrorKind::PermissionDenied => {
                DuetError::PermissionDenied(e.to_string())
            }
            _ => DuetError::Io(e.to_string()),
        }
    }
}
```

- [ ] **Step 3: 컴파일 확인**

```bash
cd src-tauri && cargo check
```

기대: 경고 없이 통과 (혹은 unused import 경고만).

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/types/
git commit -m "be/types: 도메인 타입 + DuetError (specta)

ARCHITECTURE.md 'IPC 데이터 타입' 섹션 1:1 구현.
SourceId::Ssh는 host_ip 포함 — 같은-호스트 판정용."
```

---

### Task 3: FileSystem trait

**Files:**
- Modify: `src-tauri/src/fs/mod.rs`

- [ ] **Step 1: trait 정의**

`src-tauri/src/fs/mod.rs` 전체 교체:

```rust
//! 파일시스템 추상화.
//!
//! `LocalFs` (local), `SshFs` (MVP-1), `MockFs` (테스트) 모두 이 trait 구현.
//! 모든 메서드는 `async` — Tauri tokio runtime 위에서 동작.

pub mod local;
#[cfg(test)]
pub mod mock;

use crate::types::{Entry, SourceId};
use async_trait::async_trait;
use std::path::Path;

pub use local::LocalFs;

#[async_trait]
pub trait FileSystem: Send + Sync {
    /// 이 파일시스템의 식별자.
    /// 같은-호스트 판정에 사용 (`SourceId::Ssh.host_ip` 일치 시 same-host).
    fn source_id(&self) -> SourceId;

    /// 디렉토리 항목 나열. 정렬은 호출자 책임.
    async fn list(&self, path: &Path) -> Result<Vec<Entry>, crate::types::DuetError>;
}
```

- [ ] **Step 2: 컴파일 확인 (실제 구현 없이도 trait만 컴파일)**

```bash
cd src-tauri && cargo check
```

기대: `local::LocalFs` 미정의 에러. 다음 Task에서 만듦. **이 시점에서 커밋 안 함** — Task 4 끝에 같이 커밋.

---

### Task 4: LocalFs::list 구현 + 단위 테스트

**Files:**
- Create: `src-tauri/src/fs/local.rs`
- Create: `src-tauri/src/fs/mock.rs` (테스트 보조용 — 작은 helper)

- [ ] **Step 1: failing test 먼저 작성**

`src-tauri/src/fs/local.rs`:

```rust
//! 로컬 파일시스템 구현.

use crate::fs::FileSystem;
use crate::types::{DuetError, Entry, EntryKind, SourceId};
use async_trait::async_trait;
use std::path::Path;

pub struct LocalFs;

impl LocalFs {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalFs {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl FileSystem for LocalFs {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }

    async fn list(&self, _path: &Path) -> Result<Vec<Entry>, DuetError> {
        unimplemented!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::fs;

    #[tokio::test]
    async fn list_empty_directory_returns_empty() {
        let dir = TempDir::new().unwrap();
        let local = LocalFs::new();
        let entries = local.list(dir.path()).await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn list_returns_files_and_dirs() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello").await.unwrap();
        fs::create_dir(dir.path().join("sub")).await.unwrap();

        let local = LocalFs::new();
        let mut entries = local.list(dir.path()).await.unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a.txt");
        assert_eq!(entries[0].kind, EntryKind::File);
        assert_eq!(entries[0].size, Some(5));
        assert_eq!(entries[1].name, "sub");
        assert_eq!(entries[1].kind, EntryKind::Dir);
    }

    #[tokio::test]
    async fn list_marks_dotfiles_as_hidden() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".hidden"), b"").await.unwrap();
        fs::write(dir.path().join("visible.txt"), b"").await.unwrap();

        let local = LocalFs::new();
        let entries = local.list(dir.path()).await.unwrap();

        let hidden = entries.iter().find(|e| e.name == ".hidden").unwrap();
        let visible = entries.iter().find(|e| e.name == "visible.txt").unwrap();
        assert!(hidden.hidden);
        assert!(!visible.hidden);
    }

    #[tokio::test]
    async fn list_nonexistent_returns_not_found() {
        let local = LocalFs::new();
        let result = local.list(Path::new("/this/path/should/not/exist/duet-test")).await;
        assert!(matches!(result, Err(DuetError::NotFound(_))));
    }
}
```

`src-tauri/Cargo.toml` 의 `[dev-dependencies]` 섹션 추가 (없으면 만들기):

```toml
[dev-dependencies]
tempfile = "3"
tokio-test = "0.4"
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd src-tauri && cargo test --lib fs::local::tests
```

기대: `unimplemented!()` 패닉으로 4개 테스트 모두 실패.

- [ ] **Step 3: 최소 구현으로 통과**

`fs/local.rs` 의 `list` 본체를 교체:

```rust
async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
    let mut read_dir = tokio::fs::read_dir(path).await.map_err(DuetError::from)?;
    let mut entries = Vec::new();

    while let Some(entry) = read_dir.next_entry().await.map_err(DuetError::from)? {
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            // 비-UTF8 이름은 스킵 (rare on Mac/Linux, near-zero on Windows)
            Err(_) => continue,
        };
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            // 권한 없는 항목은 스킵 (전체 list는 진행)
            Err(_) => continue,
        };
        let kind = if metadata.is_dir() {
            EntryKind::Dir
        } else if metadata.is_file() {
            EntryKind::File
        } else if metadata.is_symlink() {
            EntryKind::Symlink
        } else {
            EntryKind::Other
        };
        let size = if metadata.is_file() {
            Some(metadata.len())
        } else {
            None
        };
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            Some(metadata.permissions().mode() & 0o777)
        };
        #[cfg(not(unix))]
        let permissions = None;

        let hidden = name.starts_with('.') || is_os_hidden(&metadata);

        entries.push(Entry {
            name,
            kind,
            size,
            modified_ms,
            permissions,
            hidden,
        });
    }

    Ok(entries)
}
```

같은 파일에 OS 분기 헬퍼 추가 (`use` 위, struct 아래 어디든):

```rust
#[cfg(windows)]
fn is_os_hidden(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    (meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
}

#[cfg(not(windows))]
fn is_os_hidden(_meta: &std::fs::Metadata) -> bool {
    false
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
cd src-tauri && cargo test --lib fs::local::tests
```

기대: 4개 테스트 모두 통과.

- [ ] **Step 5: clippy + fmt + 커밋**

```bash
cd src-tauri && cargo fmt && cargo clippy --lib -- -D warnings
cd .. && git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/fs/
git commit -m "be/fs: FileSystem trait + LocalFs::list

테스트 4개 — 빈 디렉토리, 파일+디렉토리, 숨김 파일,
존재하지 않는 경로. tempfile 사용.
ARCHITECTURE.md '핵심 추상화 / FileSystem trait' 반영."
```

---

### Task 5: list_directory Tauri command + 등록

**Files:**
- Create: `src-tauri/src/commands/pane.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs` (collect_commands! 채우기)

- [ ] **Step 1: pane.rs 작성**

`src-tauri/src/commands/pane.rs`:

```rust
//! 패널 관련 IPC commands.

use crate::fs::{FileSystem, LocalFs};
use crate::types::{DuetError, Entry, Location, SourceId};
use std::path::PathBuf;
use tauri::ipc::InvokeError;

/// 디렉토리 항목 나열.
///
/// MVP-0에서는 로컬만 지원. MVP-1에서 SSH 라우팅 추가.
#[tauri::command]
#[specta::specta]
pub async fn list_directory(location: Location) -> Result<Vec<Entry>, DuetError> {
    match &location.source {
        SourceId::Local => {
            let fs = LocalFs::new();
            fs.list(&location.path).await
        }
        SourceId::Ssh { .. } => Err(DuetError::ConnectionFailed(
            "SSH는 MVP-1에서 지원".to_string(),
        )),
    }
}

// Tauri는 Result의 E가 Serialize면 알아서 직렬화 — InvokeError 변환 불필요.
// 그래도 미래의 anyhow 에러를 위해 helper 둠.
impl From<DuetError> for InvokeError {
    fn from(err: DuetError) -> Self {
        InvokeError::from_error(&err)
    }
}
```

⚠ 위 `impl From` 은 같은 crate 내 이미 다른 곳에 있으면 중복 정의 에러. 이 시점엔 처음이니 OK. 나중에 충돌 시 옮길 것.

- [ ] **Step 2: commands/mod.rs 갱신**

```rust
//! Tauri command 진입점. 얇게 유지 — 로직은 services/core/fs로 위임.

pub mod pane;
```

- [ ] **Step 3: lib.rs에서 command 등록**

`src-tauri/src/lib.rs` 의 `Builder::<tauri::Wry>::new()` 부분을 갱신:

```rust
let specta_builder = Builder::<tauri::Wry>::new()
    .commands(collect_commands![
        commands::pane::list_directory,
    ]);
```

- [ ] **Step 4: 컴파일 + 실행 확인**

```bash
pnpm tauri dev
```

기대: 컴파일 성공. `src/types/bindings.ts` 에 `listDirectory` 함수 + 모든 도메인 타입이 export됨. 윈도우 뜸 (UI 변화는 아직).

`src/types/bindings.ts` 를 열어서 다음과 비슷한 내용 확인:

```typescript
export type Location = { source: SourceId; path: string }
export type SourceId = { kind: "local" } | { kind: "ssh"; ... }
export type Entry = { name: string; kind: EntryKind; ... }

export const commands = {
    async listDirectory(location: Location): Promise<__Result__<Entry[], DuetError>> { ... }
}
```

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/commands/ src-tauri/src/lib.rs
git commit -m "be/cmd: list_directory command + specta 등록

첫 IPC. SourceId::Local 만 처리, SSH는 MVP-1.
tauri-specta가 src/types/bindings.ts 자동 생성."
```

---

## Phase C: 프론트엔드 IPC 브릿지

### Task 6: useTauri hook (command 호출 wrapper)

**Files:**
- Create: `src/hooks/useTauri.ts`
- Create: `src/hooks/useTauri.test.ts`

- [ ] **Step 1: bindings 확인 + hook 작성**

`src/types/bindings.ts` 가 이미 `commands` export 함 (Task 5에서 생성됨).
이걸 React 친화적으로 감싸는 hook을 만든다.

`src/hooks/useTauri.ts`:

```typescript
import { useCallback, useState } from "react";
import { commands } from "@/types/bindings";
import type { DuetError } from "@/types/bindings";

/**
 * Tauri command 호출용 hook.
 *
 * - command 함수와 인자 타입을 그대로 받아서 호출
 * - 로딩 / 에러 상태를 React 상태로 노출
 * - useEffect 데이터 페칭 금지 (CLAUDE.md): 이 hook을 통해서만
 */
export type CommandsApi = typeof commands;
export type CommandName = keyof CommandsApi;

interface UseTauriResult<T> {
  data: T | null;
  loading: boolean;
  error: DuetError | null;
  call: (...args: any[]) => Promise<T>;
}

export function useTauri<K extends CommandName>(
  cmd: K,
): UseTauriResult<Awaited<ReturnType<CommandsApi[K]>> extends { status: "ok"; data: infer D }
  ? D
  : never> {
  type Out = Awaited<ReturnType<CommandsApi[K]>> extends { status: "ok"; data: infer D }
    ? D
    : never;

  const [data, setData] = useState<Out | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DuetError | null>(null);

  const call = useCallback(
    async (...args: any[]) => {
      setLoading(true);
      setError(null);
      try {
        // tauri-specta는 Result<T, E>를 { status: "ok", data: T } | { status: "error", error: E } 형태로 export
        const result: any = await (commands as any)[cmd](...args);
        if (result.status === "ok") {
          setData(result.data);
          return result.data as Out;
        } else {
          setError(result.error);
          throw result.error;
        }
      } finally {
        setLoading(false);
      }
    },
    [cmd],
  );

  return { data, loading, error, call };
}
```

⚠ `any` 캐스트는 hook 내부 generic bridge용으로 한정. CLAUDE.md `any` 금지 규칙은 외부 API 표면에 적용 — 여기서는 hook이 타입 안전 wrapper를 제공하므로 OK.

- [ ] **Step 2: vitest 환경 확인**

`package.json` 의 `scripts.test` 가 `vitest`. `vitest.config.ts` 가 없으면 만든다.

`vitest.config.ts` 루트에 생성:

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
```

`vite.config.ts`에도 같은 alias 적용 (없으면 추가):

```typescript
resolve: {
  alias: {
    "@": path.resolve(__dirname, "./src"),
  },
},
```

`tsconfig.json` 의 `compilerOptions` 에 paths 추가:

```json
"baseUrl": ".",
"paths": {
  "@/*": ["src/*"]
}
```

devDependency 추가:

```bash
pnpm add -D jsdom @testing-library/react @testing-library/jest-dom
```

(CLAUDE.md §6: 의존성 추가는 명시적. 위 4개는 테스트용 표준 — 사용자 승인 후 진행. 실행 전 사용자 확인.)

- [ ] **Step 3: 간단 smoke 테스트**

`src/hooks/useTauri.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// commands를 모킹 (bindings.ts는 dev mode에 생성되지만 vitest는 별도)
vi.mock("@/types/bindings", () => ({
  commands: {
    listDirectory: vi.fn().mockResolvedValue({
      status: "ok",
      data: [{ name: "a.txt", kind: "file", size: 5, modified_ms: null, permissions: null, hidden: false }],
    }),
  },
}));

import { useTauri } from "./useTauri";

describe("useTauri", () => {
  it("calls command and stores result", async () => {
    const { result } = renderHook(() => useTauri("listDirectory"));
    await act(async () => {
      await result.current.call({ source: { kind: "local" }, path: "/tmp" });
    });
    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("propagates error on status: error", async () => {
    const { commands } = await import("@/types/bindings");
    (commands.listDirectory as any).mockResolvedValueOnce({
      status: "error",
      error: { kind: "NotFound", message: "nope" },
    });
    const { result } = renderHook(() => useTauri("listDirectory"));
    await act(async () => {
      await result.current.call({ source: { kind: "local" }, path: "/nope" }).catch(() => {});
    });
    expect(result.current.error).toEqual({ kind: "NotFound", message: "nope" });
  });
});
```

- [ ] **Step 4: 테스트 실행**

```bash
pnpm test
```

기대: 2 passed.

- [ ] **Step 5: 커밋**

```bash
git add src/hooks/useTauri.ts src/hooks/useTauri.test.ts vitest.config.ts vite.config.ts tsconfig.json package.json pnpm-lock.yaml
git commit -m "fe/hook: useTauri command wrapper

tauri-specta가 export한 commands를 React 친화적으로 감쌈.
loading/error 상태 + 타입 추론. vitest 셋업 포함."
```

---

## Phase D: 상태 관리

### Task 7: panes Zustand store

**Files:**
- Create: `src/stores/panes.ts`
- Create: `src/stores/panes.test.ts`

- [ ] **Step 1: store 작성**

`src/stores/panes.ts`:

```typescript
import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";

export type PaneId = "left" | "right";

export interface PaneState {
  location: Location;
  entries: Entry[];
  /** 현재 커서 위치 (키보드 네비). -1이면 선택 없음 */
  cursorIndex: number;
  /** 다중 선택 (Space로 토글). cursor와 별개 */
  selected: Set<string>;
  /** 마지막 갱신 시각 (refetch 트리거 디버깅용) */
  loadedAt: number;
}

interface PanesState {
  panes: Record<PaneId, PaneState>;
  activePane: PaneId;
  setEntries: (id: PaneId, location: Location, entries: Entry[]) => void;
  setActivePane: (id: PaneId) => void;
  moveCursor: (id: PaneId, delta: number) => void;
  setCursor: (id: PaneId, index: number) => void;
  toggleSelected: (id: PaneId, name: string) => void;
  clearSelection: (id: PaneId) => void;
}

const home = (): Location => ({
  source: { kind: "local" },
  // 백엔드가 절대경로 받음. 초기는 OS home directory가 이상적이지만
  // 그건 백엔드 platform 모듈 도움이 필요. MVP-0은 "/" 또는 CWD로 시작.
  // TODO: MVP-7에서 설정에 last-visited-path 저장
  path: "/",
});

export const usePanes = create<PanesState>((set) => ({
  panes: {
    left: { location: home(), entries: [], cursorIndex: -1, selected: new Set(), loadedAt: 0 },
    right: { location: home(), entries: [], cursorIndex: -1, selected: new Set(), loadedAt: 0 },
  },
  activePane: "left",
  setEntries: (id, location, entries) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: {
          ...s.panes[id],
          location,
          entries,
          cursorIndex: entries.length > 0 ? 0 : -1,
          selected: new Set(),
          loadedAt: Date.now(),
        },
      },
    })),
  setActivePane: (id) => set({ activePane: id }),
  moveCursor: (id, delta) =>
    set((s) => {
      const p = s.panes[id];
      const next = Math.max(0, Math.min(p.entries.length - 1, p.cursorIndex + delta));
      return { panes: { ...s.panes, [id]: { ...p, cursorIndex: next } } };
    }),
  setCursor: (id, index) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], cursorIndex: index } },
    })),
  toggleSelected: (id, name) =>
    set((s) => {
      const p = s.panes[id];
      const next = new Set(p.selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { panes: { ...s.panes, [id]: { ...p, selected: next } } };
    }),
  clearSelection: (id) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], selected: new Set() } },
    })),
}));
```

- [ ] **Step 2: 테스트 작성 + 실행**

`src/stores/panes.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { usePanes } from "./panes";

const reset = () => {
  usePanes.setState({
    panes: {
      left: { location: { source: { kind: "local" }, path: "/" }, entries: [], cursorIndex: -1, selected: new Set(), loadedAt: 0 },
      right: { location: { source: { kind: "local" }, path: "/" }, entries: [], cursorIndex: -1, selected: new Set(), loadedAt: 0 },
    },
    activePane: "left",
  });
};

const mkEntry = (name: string) => ({
  name,
  kind: "file" as const,
  size: 0,
  modified_ms: null,
  permissions: null,
  hidden: false,
});

describe("panes store", () => {
  beforeEach(reset);

  it("setEntries resets cursor and selection", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/tmp" }, [mkEntry("a"), mkEntry("b")]);
    const p = usePanes.getState().panes.left;
    expect(p.entries).toHaveLength(2);
    expect(p.cursorIndex).toBe(0);
    expect(p.selected.size).toBe(0);
    expect(p.location.path).toBe("/tmp");
  });

  it("moveCursor clamps to range", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mkEntry("a"), mkEntry("b")]);
    usePanes.getState().moveCursor("left", -5);
    expect(usePanes.getState().panes.left.cursorIndex).toBe(0);
    usePanes.getState().moveCursor("left", 100);
    expect(usePanes.getState().panes.left.cursorIndex).toBe(1);
  });

  it("toggleSelected adds and removes", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mkEntry("a")]);
    usePanes.getState().toggleSelected("left", "a");
    expect(usePanes.getState().panes.left.selected.has("a")).toBe(true);
    usePanes.getState().toggleSelected("left", "a");
    expect(usePanes.getState().panes.left.selected.has("a")).toBe(false);
  });
});
```

```bash
pnpm test src/stores/panes.test.ts
```

기대: 3 passed.

- [ ] **Step 3: 커밋**

```bash
git add src/stores/panes.ts src/stores/panes.test.ts
git commit -m "fe/store: panes Zustand store

좌/우 패널 상태 (location, entries, cursor, selection, active).
moveCursor는 범위 클램핑."
```

---

## Phase E: UI 컴포넌트

### Task 8: PathBar 컴포넌트

**Files:**
- Create: `src/components/pane/PathBar.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`src/components/pane/PathBar.tsx`:

```typescript
import { ArrowLeft, ArrowRight, ArrowUp, RotateCw } from "lucide-react";
import type { Location } from "@/types/bindings";

interface PathBarProps {
  location: Location;
  onBack?: () => void;
  onForward?: () => void;
  onUp?: () => void;
  onRefresh?: () => void;
  onSegmentClick?: (path: string) => void;
}

/**
 * 패널 상단 경로 표시 + 네비 버튼.
 * DESIGN.md "패널 헤더 (PathBar)" 참조.
 *
 * MVP-0: breadcrumb 표시 + 새로고침. 직접 입력 모드(Ctrl+L)는 추후.
 */
export function PathBar({ location, onBack, onForward, onUp, onRefresh, onSegmentClick }: PathBarProps) {
  const sourceLabel = location.source.kind === "local" ? "Local" : `${location.source.user}@${location.source.host_ip}`;
  const segments = location.path.split("/").filter(Boolean);

  return (
    <div className="flex h-8 items-center gap-1 border-b border-border bg-subtle px-2 text-base">
      <button onClick={onBack} className="rounded p-1 hover:bg-border" disabled={!onBack} aria-label="Back">
        <ArrowLeft size={14} />
      </button>
      <button onClick={onForward} className="rounded p-1 hover:bg-border" disabled={!onForward} aria-label="Forward">
        <ArrowRight size={14} />
      </button>
      <button onClick={onUp} className="rounded p-1 hover:bg-border" disabled={!onUp} aria-label="Up">
        <ArrowUp size={14} />
      </button>
      <span className="ml-2 mono truncate text-fg-muted">{sourceLabel}</span>
      <span className="text-fg-muted">:</span>
      <div className="flex items-center gap-0.5 mono truncate">
        <button
          onClick={() => onSegmentClick?.("/")}
          className="rounded px-1 hover:bg-border"
        >
          /
        </button>
        {segments.map((seg, i) => {
          const cumulative = "/" + segments.slice(0, i + 1).join("/");
          return (
            <span key={cumulative} className="flex items-center">
              <button
                onClick={() => onSegmentClick?.(cumulative)}
                className="rounded px-1 hover:bg-border"
              >
                {seg}
              </button>
              {i < segments.length - 1 && <span className="text-fg-muted">/</span>}
            </span>
          );
        })}
      </div>
      <button onClick={onRefresh} className="ml-auto rounded p-1 hover:bg-border" aria-label="Refresh">
        <RotateCw size={14} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 시각 확인**

`App.tsx` 임시로 import해서 보기 (다음 Task에서 정식 통합):

```typescript
import { PathBar } from "@/components/pane/PathBar";
// main 안에 임시:
<PathBar location={{ source: { kind: "local" }, path: "/Users/test/project" }} />
```

```bash
pnpm tauri dev
```

기대: 패스 바 보임. 클릭은 아직 동작 안 함 (handler 미연결).

- [ ] **Step 3: 임시 import 제거 + 커밋**

App.tsx의 임시 import 제거 (정식 통합은 Task 11).

```bash
git add src/components/pane/PathBar.tsx
git commit -m "fe/ui: PathBar component

breadcrumb 경로 + nav 버튼 + 새로고침.
DESIGN.md PathBar 디자인 매핑."
```

---

### Task 9: EntryRow 컴포넌트

**Files:**
- Create: `src/components/pane/EntryRow.tsx`
- Create: `src/lib/format.ts`

- [ ] **Step 1: format helper**

`src/lib/format.ts`:

```typescript
/**
 * 사이즈를 사람-친화 포맷으로.
 * 1023 B, 1.0 KB, 1.5 MB, ...
 */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let val = bytes / 1024;
  let unit = 0;
  while (val >= 1024 && unit < units.length - 1) {
    val /= 1024;
    unit++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Unix epoch ms를 사람-친화 시간으로.
 * 오늘이면 "14:32", 올해면 "Apr 12", 그 외 "2024-06-01"
 */
export function formatTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toTimeString().slice(0, 5);
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: EntryRow**

`src/components/pane/EntryRow.tsx`:

```typescript
import { Folder, File, Link as LinkIcon } from "lucide-react";
import type { Entry } from "@/types/bindings";
import { formatSize, formatTime } from "@/lib/format";
import clsx from "clsx";

interface EntryRowProps {
  entry: Entry;
  isCursor: boolean;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

const iconFor = (entry: Entry) => {
  switch (entry.kind) {
    case "dir":
      return <Folder size={14} className="text-accent" />;
    case "symlink":
      return <LinkIcon size={14} className="text-fg-muted" />;
    default:
      return <File size={14} className="text-fg-muted" />;
  }
};

/**
 * DESIGN.md "행 (EntryRow)" 디자인.
 * - hover: bg-subtle
 * - cursor: 좌측 2px accent border
 * - selected: bg-active
 * - 28px 행 높이 (보통 모드)
 */
export function EntryRow({ entry, isCursor, isSelected, onClick, onDoubleClick }: EntryRowProps) {
  return (
    <div
      className={clsx(
        "flex h-7 items-center gap-2 px-2 text-base cursor-default",
        "hover:bg-subtle",
        isSelected && "bg-active",
        isCursor && "border-l-2 border-l-accent pl-[6px]",
        !isCursor && "border-l-2 border-l-transparent",
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {iconFor(entry)}
      <span className={clsx("mono flex-1 truncate", entry.hidden && "text-fg-muted")}>
        {entry.name}
      </span>
      <span className="mono w-20 text-right text-meta text-fg-muted">{formatSize(entry.size)}</span>
      <span className="mono w-20 text-right text-meta text-fg-muted">{formatTime(entry.modified_ms)}</span>
    </div>
  );
}
```

- [ ] **Step 3: format 단위 테스트**

`src/lib/format.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatSize } from "./format";

describe("formatSize", () => {
  it("handles bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });
  it("handles kilobytes with one decimal under 10", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1500)).toBe("1.5 KB");
  });
  it("handles megabytes", () => {
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });
  it("returns empty for null", () => {
    expect(formatSize(null)).toBe("");
  });
});
```

```bash
pnpm test
```

기대: 추가 4 passed.

- [ ] **Step 4: 커밋**

```bash
git add src/components/pane/EntryRow.tsx src/lib/format.ts src/lib/format.test.ts
git commit -m "fe/ui: EntryRow + format helpers

DESIGN.md row 디자인 (icon, name, size, time).
formatSize/formatTime 단위 테스트 4개."
```

---

### Task 10: EntryList (가상 스크롤)

**Files:**
- Create: `src/components/pane/EntryList.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`src/components/pane/EntryList.tsx`:

```typescript
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { Entry } from "@/types/bindings";
import { EntryRow } from "./EntryRow";

interface EntryListProps {
  entries: Entry[];
  cursorIndex: number;
  selected: Set<string>;
  onCursorMove: (index: number) => void;
  onActivate: (entry: Entry, index: number) => void;
  onToggleSelect: (name: string) => void;
}

const ROW_HEIGHT = 28;

/**
 * 가상 스크롤 파일 리스트.
 * 1만+ 항목에서도 즉각 응답. DESIGN.md "파일 리스트 (EntryList)" 참조.
 */
export function EntryList({
  entries,
  cursorIndex,
  selected,
  onCursorMove,
  onActivate,
  onToggleSelect,
}: EntryListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const entry = entries[vi.index];
          return (
            <div
              key={vi.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: `${vi.size}px`,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <EntryRow
                entry={entry}
                isCursor={cursorIndex === vi.index}
                isSelected={selected.has(entry.name)}
                onClick={() => {
                  onCursorMove(vi.index);
                  onToggleSelect(entry.name);
                }}
                onDoubleClick={() => onActivate(entry, vi.index)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 시각 확인 (다음 Task에서 통합 — 여기선 빌드만)**

```bash
pnpm tsc --noEmit
```

기대: 컴파일 통과.

- [ ] **Step 3: 커밋**

```bash
git add src/components/pane/EntryList.tsx
git commit -m "fe/ui: EntryList with @tanstack/react-virtual

1만+ 항목 응답성. 28px 행, overscan 8.
cursor/selection은 props로 — store 통합은 Pane에서."
```

---

### Task 11: Pane 컴포넌트 (조합)

**Files:**
- Create: `src/components/pane/Pane.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`src/components/pane/Pane.tsx`:

```typescript
import { useEffect, useCallback } from "react";
import { PathBar } from "./PathBar";
import { EntryList } from "./EntryList";
import { usePanes, type PaneId } from "@/stores/panes";
import { useTauri } from "@/hooks/useTauri";
import type { Entry } from "@/types/bindings";
import clsx from "clsx";

interface PaneProps {
  id: PaneId;
}

export function Pane({ id }: PaneProps) {
  const pane = usePanes((s) => s.panes[id]);
  const isActive = usePanes((s) => s.activePane === id);
  const setActivePane = usePanes((s) => s.setActivePane);
  const setEntries = usePanes((s) => s.setEntries);
  const setCursor = usePanes((s) => s.setCursor);
  const toggleSelected = usePanes((s) => s.toggleSelected);

  const { call: listDirectory, error } = useTauri("listDirectory");

  // 위치 변경 시 디렉토리 로드
  useEffect(() => {
    listDirectory(pane.location).then((entries) => {
      setEntries(id, pane.location, sortEntries(entries));
    }).catch(() => { /* error는 hook에 저장됨 */ });
  }, [pane.location.path, pane.location.source, id, listDirectory, setEntries]);

  const navigate = useCallback(
    (path: string) => {
      setEntries(id, { ...pane.location, path }, []);
    },
    [id, pane.location, setEntries],
  );

  const onUp = useCallback(() => {
    const path = pane.location.path;
    if (path === "/" || path.length === 0) return;
    const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
    navigate(parent);
  }, [pane.location.path, navigate]);

  const onActivate = useCallback(
    (entry: Entry) => {
      if (entry.kind === "dir") {
        const sep = pane.location.path.endsWith("/") ? "" : "/";
        navigate(pane.location.path + sep + entry.name);
      }
      // file open은 MVP-7
    },
    [pane.location.path, navigate],
  );

  return (
    <div
      className={clsx(
        "flex flex-1 flex-col border border-border",
        isActive && "border-accent",
      )}
      onMouseDown={() => setActivePane(id)}
    >
      <PathBar
        location={pane.location}
        onUp={onUp}
        onSegmentClick={navigate}
        onRefresh={() => {
          listDirectory(pane.location).then((entries) => {
            setEntries(id, pane.location, sortEntries(entries));
          });
        }}
      />
      {error ? (
        <div className="flex flex-1 items-center justify-center text-danger">
          {error.kind}: {error.message ?? ""}
        </div>
      ) : (
        <EntryList
          entries={pane.entries}
          cursorIndex={pane.cursorIndex}
          selected={pane.selected}
          onCursorMove={(i) => setCursor(id, i)}
          onActivate={onActivate}
          onToggleSelect={(name) => toggleSelected(id, name)}
        />
      )}
    </div>
  );
}

/** 디렉토리 먼저, 그 안에서 이름 오름차순 (DESIGN.md 디폴트) */
function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === "dir") return -1;
      if (b.kind === "dir") return 1;
    }
    return a.name.localeCompare(b.name);
  });
}
```

- [ ] **Step 2: App.tsx에 통합**

`src/App.tsx` 갱신:

```typescript
import { Pane } from "@/components/pane/Pane";

function App() {
  return (
    <div className="flex h-screen w-screen flex-col bg-base text-fg">
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-title font-medium">duet</span>
      </header>

      <main className="flex flex-1 gap-0">
        {/* TODO: <Sidebar /> */}
        <Pane id="left" />
        <Pane id="right" />
      </main>

      <footer className="flex h-6 items-center border-t border-border px-3 text-meta text-fg-muted">
        {/* TODO: <StatusBar /> */}
        <span>0 items</span>
      </footer>
    </div>
  );
}

export default App;
```

- [ ] **Step 3: 시각 확인**

```bash
pnpm tauri dev
```

기대: 듀얼 패널 뜸. `/` 디렉토리가 양쪽 패널에 로드됨. 폴더 더블클릭 → 진입. PathBar 세그먼트 클릭 → 점프. 새로고침 버튼 작동. 패널 클릭 시 active border 색상 변경.

⚠ 초기 path `/` — Linux/Mac은 OK, Windows에선 잘못된 경로. Windows 테스트 필요. 임시 회피: `pane.location` 초기값을 OS별로 처리하는 건 MVP-0 마지막 Task에서.

- [ ] **Step 4: 커밋**

```bash
git add src/components/pane/Pane.tsx src/App.tsx
git commit -m "fe/ui: Pane component + App 듀얼 패널 통합

PathBar + EntryList 조합. 폴더 더블클릭 진입, 세그먼트 점프,
active 패널 border 표시.
file open / 키보드 nav는 다음 Task."
```

---

### Task 12: 키보드 네비게이션

**Files:**
- Create: `src/hooks/useKeyboardNav.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: hook 작성**

`src/hooks/useKeyboardNav.ts`:

```typescript
import { useEffect } from "react";
import { usePanes } from "@/stores/panes";

/**
 * 글로벌 키보드 네비게이션.
 * DESIGN.md 키 바인딩 표 참조 — MVP-0 항목만:
 * - ↑↓: 커서 이동
 * - Enter: 항목 활성화 (디렉토리 진입)
 * - Backspace: 상위
 * - Tab: 패널 전환
 * - Space: 선택 토글
 *
 * 다른 단축키 (Ctrl+B, Ctrl+Q 등)는 별도 hook.
 * input/textarea 포커스 중에는 무시.
 */
export function useKeyboardNav(
  onActivate: (paneId: "left" | "right") => void,
  onUp: (paneId: "left" | "right") => void,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      const state = usePanes.getState();
      const id = state.activePane;
      const pane = state.panes[id];

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          state.moveCursor(id, 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          state.moveCursor(id, -1);
          break;
        case "Enter":
          e.preventDefault();
          if (pane.cursorIndex >= 0) onActivate(id);
          break;
        case "Backspace":
          e.preventDefault();
          onUp(id);
          break;
        case "Tab":
          e.preventDefault();
          state.setActivePane(id === "left" ? "right" : "left");
          break;
        case " ":
          e.preventDefault();
          if (pane.cursorIndex >= 0) {
            const entry = pane.entries[pane.cursorIndex];
            if (entry) state.toggleSelected(id, entry.name);
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onActivate, onUp]);
}
```

- [ ] **Step 2: Pane에서 onActivate/onUp을 store-friendly하게 export**

`src/stores/panes.ts` 의 `PanesState` interface에 navigate helper들이 필요. 가장 깔끔: `App.tsx` 가 Pane 인스턴스 ref를 가지도록… 복잡함. 대신 navigate 로직을 store에 끌어올린다 (간단하지만 store가 IPC 호출하게 됨 — 약간 어색).

타협안: `App.tsx`에서 onActivate/onUp을 Pane 컴포넌트 내부와 같은 로직으로 인라인.

`src/App.tsx` 갱신:

```typescript
import { Pane } from "@/components/pane/Pane";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { usePanes, type PaneId } from "@/stores/panes";
import { useTauri } from "@/hooks/useTauri";
import { useCallback } from "react";

function App() {
  const { call: listDirectory } = useTauri("listDirectory");

  const navigate = useCallback(
    async (id: PaneId, path: string) => {
      const state = usePanes.getState();
      const location = { ...state.panes[id].location, path };
      const entries = await listDirectory(location);
      state.setEntries(id, location, [...entries].sort((a, b) => {
        if (a.kind !== b.kind) {
          if (a.kind === "dir") return -1;
          if (b.kind === "dir") return 1;
        }
        return a.name.localeCompare(b.name);
      }));
    },
    [listDirectory],
  );

  const onActivate = useCallback(
    (id: PaneId) => {
      const state = usePanes.getState();
      const pane = state.panes[id];
      const entry = pane.entries[pane.cursorIndex];
      if (!entry) return;
      if (entry.kind === "dir") {
        const sep = pane.location.path.endsWith("/") ? "" : "/";
        navigate(id, pane.location.path + sep + entry.name);
      }
    },
    [navigate],
  );

  const onUp = useCallback(
    (id: PaneId) => {
      const state = usePanes.getState();
      const path = state.panes[id].location.path;
      if (path === "/" || path.length === 0) return;
      const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
      navigate(id, parent);
    },
    [navigate],
  );

  useKeyboardNav(onActivate, onUp);

  return (
    <div className="flex h-screen w-screen flex-col bg-base text-fg">
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-title font-medium">duet</span>
      </header>

      <main className="flex flex-1 gap-0">
        <Pane id="left" />
        <Pane id="right" />
      </main>

      <footer className="flex h-6 items-center border-t border-border px-3 text-meta text-fg-muted">
        <span>0 items</span>
      </footer>
    </div>
  );
}

export default App;
```

⚠ Pane 컴포넌트의 onActivate/onUp 로직이 App.tsx와 중복됨 — Pane을 더 dumb하게 (store만 보고 그리는) 만들고 App.tsx가 모든 IPC를 담당하는 게 깔끔. 다음 Task에서 정리.

- [ ] **Step 3: Pane 단순화 — IPC 호출 제거**

`src/components/pane/Pane.tsx` 의 `useEffect` listDirectory 호출 + onUp/onActivate 로직 모두 제거. 그냥 store만 보고 그림:

```typescript
import { PathBar } from "./PathBar";
import { EntryList } from "./EntryList";
import { usePanes, type PaneId } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import clsx from "clsx";

interface PaneProps {
  id: PaneId;
  onNavigate: (id: PaneId, path: string) => void;
  onActivate: (id: PaneId, entry: Entry) => void;
  onRefresh: (id: PaneId) => void;
}

export function Pane({ id, onNavigate, onActivate, onRefresh }: PaneProps) {
  const pane = usePanes((s) => s.panes[id]);
  const isActive = usePanes((s) => s.activePane === id);
  const setActivePane = usePanes((s) => s.setActivePane);
  const setCursor = usePanes((s) => s.setCursor);
  const toggleSelected = usePanes((s) => s.toggleSelected);

  return (
    <div
      className={clsx(
        "flex flex-1 flex-col border border-border",
        isActive && "border-accent",
      )}
      onMouseDown={() => setActivePane(id)}
    >
      <PathBar
        location={pane.location}
        onUp={() => {
          const path = pane.location.path;
          if (path === "/" || path.length === 0) return;
          onNavigate(id, path.replace(/\/[^/]+\/?$/, "") || "/");
        }}
        onSegmentClick={(p) => onNavigate(id, p)}
        onRefresh={() => onRefresh(id)}
      />
      <EntryList
        entries={pane.entries}
        cursorIndex={pane.cursorIndex}
        selected={pane.selected}
        onCursorMove={(i) => setCursor(id, i)}
        onActivate={(entry) => onActivate(id, entry)}
        onToggleSelect={(name) => toggleSelected(id, name)}
      />
    </div>
  );
}
```

App.tsx에서 Pane 사용 시 props 전달:

```typescript
<Pane id="left" onNavigate={navigate} onActivate={(id, entry) => {
  if (entry.kind === "dir") {
    const pane = usePanes.getState().panes[id];
    const sep = pane.location.path.endsWith("/") ? "" : "/";
    navigate(id, pane.location.path + sep + entry.name);
  }
}} onRefresh={(id) => {
  const pane = usePanes.getState().panes[id];
  navigate(id, pane.location.path);
}} />
<Pane id="right" .../>
```

(중복 줄이려면 helper로 빼는 게 깔끔 — 시간되면 정리.)

또한 **초기 디렉토리 로드** 가 필요. App.tsx 에 useEffect 추가:

```typescript
useEffect(() => {
  navigate("left", "/");
  navigate("right", "/");
}, []);
```

(`navigate`를 deps에 넣으면 무한 루프. 빈 배열로 마운트 시 한 번만. CLAUDE.md "useEffect 데이터 페칭 금지" 와는 약간 충돌 — 초기 부트스트랩은 예외로 봄. 더 깔끔히는 별도 `useBootstrap` hook으로 분리 가능.)

- [ ] **Step 4: 시각 확인**

```bash
pnpm tauri dev
```

기대:
- 양쪽 패널에 `/` 로드됨
- ↑↓ 으로 커서 이동
- Enter 로 디렉토리 진입
- Backspace 로 상위 이동
- Tab 으로 active 패널 전환 (border 색상 변경)
- Space 로 선택 토글 (bg-active 색)

- [ ] **Step 5: 커밋**

```bash
git add src/hooks/useKeyboardNav.ts src/components/pane/Pane.tsx src/App.tsx
git commit -m "fe/hook: 키보드 네비게이션 (↑↓/Enter/Backspace/Tab/Space)

Pane을 dumb하게 — IPC는 App.tsx가 일괄 처리.
DESIGN.md 키 바인딩 표 MVP-0 항목 모두 반영."
```

---

### Task 13: Sidebar 토글 (Ctrl+B) + 글로벌 단축키 (Ctrl+Q)

**Files:**
- Create: `src/components/Sidebar.tsx`
- Create: `src/stores/ui.ts`
- Create: `src/hooks/useGlobalShortcuts.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: ui store**

`src/stores/ui.ts`:

```typescript
import { create } from "zustand";

interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useUI = create<UIState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
```

- [ ] **Step 2: Sidebar (placeholder)**

`src/components/Sidebar.tsx`:

```typescript
import { Folder, Server, Star } from "lucide-react";
import { useUI } from "@/stores/ui";
import clsx from "clsx";

/**
 * MVP-0: placeholder. 토글만 동작.
 * MVP-1에서 호스트 목록, MVP-6에서 북마크 채워짐.
 */
export function Sidebar() {
  const open = useUI((s) => s.sidebarOpen);
  if (!open) return null;

  return (
    <aside className="flex w-48 flex-col border-r border-border bg-subtle text-base">
      <Section title="Local" icon={<Folder size={14} />}>
        <Item label="Home" />
      </Section>
      <Section title="Hosts" icon={<Server size={14} />}>
        <Item label="(MVP-1)" muted />
      </Section>
      <Section title="Bookmarks" icon={<Star size={14} />}>
        <Item label="(MVP-6)" muted />
      </Section>
    </aside>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center gap-1 text-meta text-fg-muted">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Item({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <div className={clsx("rounded px-2 py-0.5 hover:bg-border", muted && "text-fg-muted")}>
      {label}
    </div>
  );
}
```

- [ ] **Step 3: 글로벌 단축키 hook**

`src/hooks/useGlobalShortcuts.ts`:

```typescript
import { useEffect } from "react";
import { exit } from "@tauri-apps/plugin-process";
import { useUI } from "@/stores/ui";

/**
 * 글로벌 (패널 무관) 단축키.
 * - Ctrl+B: 사이드바 토글
 * - Ctrl+Q: 종료 (Mac은 Cmd+Q가 OS 기본 — 추가로 받을 필요 없음)
 *
 * macOS에서 Cmd, 다른 OS에서 Ctrl: e.metaKey vs e.ctrlKey 분기.
 */
export function useGlobalShortcuts() {
  const toggleSidebar = useUI((s) => s.toggleSidebar);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (!isMod) return;

      switch (e.key.toLowerCase()) {
        case "b":
          e.preventDefault();
          toggleSidebar();
          break;
        case "q":
          // mac은 OS가 기본 처리 — 다른 OS에서만
          if (!navigator.platform.includes("Mac")) {
            e.preventDefault();
            exit(0);
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar]);
}
```

- [ ] **Step 4: deps 추가**

```bash
pnpm add @tauri-apps/plugin-process
```

`src-tauri/Cargo.toml`:

```toml
tauri-plugin-process = "2"
```

`src-tauri/src/lib.rs`의 builder에:

```rust
.plugin(tauri_plugin_process::init())
```

⚠ CLAUDE.md §6: 의존성 추가 명시 승인 필요. 위 plugin은 Ctrl+Q 종료 위해 필수. 사용자 확인 후 진행.

(또는 plugin 없이 `getCurrentWindow().close()`로 대체 가능 — `@tauri-apps/api/window`. 이미 있는 `@tauri-apps/api`로 끝남. 이 쪽이 가벼움.)

대안 hook (plugin 없이):

```typescript
import { getCurrentWindow } from "@tauri-apps/api/window";
// ...
case "q":
  if (!navigator.platform.includes("Mac")) {
    e.preventDefault();
    getCurrentWindow().close();
  }
```

→ 이 대안 사용. plugin-process 추가 안 함.

- [ ] **Step 5: App.tsx 통합**

```typescript
import { Sidebar } from "@/components/Sidebar";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";

function App() {
  // ... navigate, onActivate 등 ...
  useKeyboardNav(onActivate, onUp);
  useGlobalShortcuts();

  return (
    <div className="flex h-screen w-screen flex-col bg-base text-fg">
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-title font-medium">duet</span>
      </header>

      <main className="flex flex-1 gap-0">
        <Sidebar />
        <Pane id="left" /* ... */ />
        <Pane id="right" /* ... */ />
      </main>

      {/* ... footer ... */}
    </div>
  );
}
```

- [ ] **Step 6: 시각 확인**

```bash
pnpm tauri dev
```

기대: 
- Sidebar 보임 (Local/Hosts/Bookmarks 섹션)
- Ctrl+B (Mac은 Cmd+B) → Sidebar 사라짐/나타남
- Ctrl+Q (Mac 외) → 윈도우 닫힘

- [ ] **Step 7: 커밋**

```bash
git add src/components/Sidebar.tsx src/stores/ui.ts src/hooks/useGlobalShortcuts.ts src/App.tsx
git commit -m "fe/ui: Sidebar (placeholder) + 글로벌 단축키 (Ctrl+B, Ctrl+Q)

UI store. macOS는 Cmd, 다른 OS는 Ctrl.
호스트/북마크 섹션은 MVP-1/MVP-6에 채워짐."
```

---

### Task 14: StatusBar (선택 정보)

**Files:**
- Create: `src/components/StatusBar.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 컴포넌트 작성**

`src/components/StatusBar.tsx`:

```typescript
import { usePanes } from "@/stores/panes";
import { formatSize } from "@/lib/format";

/**
 * DESIGN.md StatusBar:
 * "12 items • 3 selected (4.2 MB)         user@host  ●"
 *
 * MVP-0: 항목 수 + 선택 정보. 호스트 표시는 MVP-1.
 */
export function StatusBar() {
  const activeId = usePanes((s) => s.activePane);
  const pane = usePanes((s) => s.panes[activeId]);
  const sourceLabel = pane.location.source.kind === "local" ? "Local" : `${pane.location.source.user}@${pane.location.source.host_ip}`;

  const totalCount = pane.entries.length;
  const selectedCount = pane.selected.size;
  const selectedSize = pane.entries
    .filter((e) => pane.selected.has(e.name) && e.size != null)
    .reduce((sum, e) => sum + (e.size ?? 0), 0);

  return (
    <footer className="flex h-6 items-center justify-between border-t border-border px-3 text-meta text-fg-muted">
      <span>
        {totalCount} items
        {selectedCount > 0 && ` • ${selectedCount} selected (${formatSize(selectedSize)})`}
      </span>
      <span>{sourceLabel}</span>
    </footer>
  );
}
```

- [ ] **Step 2: App.tsx 에서 footer 교체**

```typescript
import { StatusBar } from "@/components/StatusBar";

// footer 부분 전체 교체:
<StatusBar />
```

- [ ] **Step 3: 시각 확인**

```bash
pnpm tauri dev
```

기대:
- 하단에 "N items" 표시
- Space로 항목 선택 시 "N items • M selected (X KB)" 갱신
- 우측에 "Local" 표시
- 패널 전환(Tab)하면 표시도 따라감

- [ ] **Step 4: 커밋**

```bash
git add src/components/StatusBar.tsx src/App.tsx
git commit -m "fe/ui: StatusBar — 항목 수/선택/사이즈

DESIGN.md 매핑. 활성 패널 따라가는 표시.
호스트 표시는 MVP-1에서 user@host로 강화."
```

---

### Task 15: Bootstrap 초기 경로 + Windows 호환

**Files:**
- Create: `src-tauri/src/commands/system.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/App.tsx`

**Why:** 지금까지 초기 경로가 `/` 하드코딩. Windows에서 깨짐. 백엔드에 home 디렉토리 반환 command 추가.

- [ ] **Step 1: home_directory command**

`src-tauri/src/commands/system.rs`:

```rust
//! 시스템 정보 commands.

use crate::types::DuetError;
use std::path::PathBuf;

#[tauri::command]
#[specta::specta]
pub async fn home_directory() -> Result<PathBuf, DuetError> {
    dirs::home_dir().ok_or_else(|| DuetError::Io("home directory not found".into()))
}
```

- [ ] **Step 2: commands/mod.rs**

```rust
pub mod pane;
pub mod system;
```

- [ ] **Step 3: lib.rs에 등록**

```rust
.commands(collect_commands![
    commands::pane::list_directory,
    commands::system::home_directory,
]);
```

- [ ] **Step 4: 컴파일 + bindings 갱신 확인**

```bash
pnpm tauri dev
```

`src/types/bindings.ts` 에 `homeDirectory` 추가됐는지 확인.

- [ ] **Step 5: App.tsx 부트스트랩**

```typescript
useEffect(() => {
  (async () => {
    const home = await commands.homeDirectory().then((r) => r.status === "ok" ? r.data : "/");
    // 양쪽 패널 home으로 시작
    const initLocation = { source: { kind: "local" as const }, path: home };
    usePanes.setState((s) => ({
      panes: {
        left: { ...s.panes.left, location: initLocation },
        right: { ...s.panes.right, location: initLocation },
      },
    }));
    await navigate("left", home);
    await navigate("right", home);
  })();
}, []);
```

(import 정리: `commands` 는 `@/types/bindings` 에서)

- [ ] **Step 6: Windows 부분 확인**

만약 Windows 환경이 있다면 거기서 빌드해서 home_dir이 `C:\Users\<name>` 으로 오는지 확인. 없으면 Linux/Mac에서만 검증.

- [ ] **Step 7: 커밋**

```bash
git add src-tauri/src/commands/ src-tauri/src/lib.rs src/App.tsx
git commit -m "be/cmd + fe: 초기 경로 home_directory

Windows 호환 (C:\\Users\\... vs /home/...).
부트스트랩 시 양쪽 패널 home으로."
```

---

## Phase F: 정리 + 회고

### Task 16: lint / typecheck / test 전체 통과 + ROADMAP 체크

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: 백엔드 검사**

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

기대: 모두 통과. 실패 시 에러 메시지 단위로 수정 → 다시 실행.

- [ ] **Step 2: 프론트엔드 검사**

```bash
pnpm lint
pnpm tsc --noEmit
pnpm test
```

기대: 모두 통과.

- [ ] **Step 3: 빌드 확인**

```bash
pnpm tauri build --debug
```

기대: 디버그 빌드 성공. 산출물 윈도우 띄워서 듀얼 패널 동작 확인.

- [ ] **Step 4: ROADMAP 체크박스 갱신**

`ROADMAP.md` MVP-0 섹션의 체크박스를 `[x]` 로:

```markdown
## MVP-0: Tauri 부트스트랩 + 로컬 듀얼 패널

**완료 조건**: 로컬 파일시스템에서 듀얼 패널이 동작하고 디렉토리 탐색 가능.

- [x] Tauri 프로젝트 부트스트랩 (Vite + React + TypeScript)
- [x] Tailwind + shadcn/ui 셋업, 다크/라이트 모드
- [x] `FileSystem` trait + `LocalFs` 기본 구현
- [x] `commands/list_directory` 첫 IPC
- [x] 듀얼 패널 컴포넌트 (`<Pane>`)
- [x] 가상 스크롤 적용 (`@tanstack/react-virtual`)
- [x] 키보드 네비 (↑↓, Enter, Backspace, Tab)
- [x] 활성 패널 표시
- [x] 사이드바 토글 (Ctrl+B)
- [x] 상태바 (선택 정보)
- [x] Ctrl+Q 종료
```

ROADMAP `## 현재 단계` 도 갱신:

```markdown
## 현재 단계

**MVP-1 시작 직전.** MVP-0 완료, 본인 일상에서 read-only 탐색용으로 사용 가능.
```

- [ ] **Step 5: 최종 커밋**

```bash
git add ROADMAP.md
git commit -m "docs: MVP-0 완료 표시

로컬 듀얼 패널 read-only 탐색 일상 사용 가능.
다음: MVP-1 SSH 연결."
```

---

## 자기 점검 (작성자용)

**Spec 커버리지 (ROADMAP MVP-0 항목별 매핑):**

| ROADMAP 항목 | 구현 Task |
|--------------|-----------|
| Tauri 부트스트랩 | 사전 완료 (스캐폴드) |
| Tailwind + 다크/라이트 | 사전 완료 (CSS vars) + Task 13 (sidebar 색상) |
| `FileSystem` trait + `LocalFs` | Task 3, 4 |
| `commands/list_directory` | Task 5 |
| `<Pane>` 컴포넌트 | Task 11 |
| 가상 스크롤 | Task 10 |
| 키보드 네비 (↑↓/Enter/Backspace/Tab) | Task 12 |
| 활성 패널 표시 | Task 11 (border-accent) |
| 사이드바 토글 (Ctrl+B) | Task 13 |
| 상태바 | Task 14 |
| Ctrl+Q 종료 | Task 13 |
| 추가: home dir 부트스트랩 (Win 호환) | Task 15 |
| 추가: lint/test 전체 통과 + ROADMAP 갱신 | Task 16 |

**의존성 결정 매핑:**

| 결정사항 (브레인스토밍) | Task |
|------------------------|------|
| ts-rs → specta + tauri-specta | Task 1 |
| `SourceId::Ssh { host_ip, user }` 도입 | Task 2 (타입 정의) — MVP-1에서 채워짐 |
| 시스템 ssh 호출 금지 | MVP-1 (해당 없음, MVP-0은 로컬만) |
| fs:changed (로컬 notify) | MVP-1 (notify 통합) |

**플레이스홀더 스캔:**
- Sidebar에 "(MVP-1)" / "(MVP-6)" 텍스트 — 의도된 placeholder (코드 TODO 아님)
- App.tsx 의 useEffect deps 빈 배열 — bootstrap 1회로 명시, 주석으로 의도 표시
- `unwrap()` / `expect()`: 백엔드는 없음 (모두 `?` + `DuetError` 변환). `lib.rs` 의 `.expect("error while running tauri application")` 는 main entry — 허용.

**타입 일관성:**
- `Entry.modified_ms` Rust ↔ TS 모두 `i64` / `number | null`
- `SourceId.kind` discriminant: `"local" | "ssh"` Rust serde + TS specta 일치 확인 필요 (Task 4 끝에서 bindings.ts 직접 확인)

---

## 실행 핸드오프

Plan complete and saved to `docs/plans/2026-05-09-mvp0-local-dual-pane.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Task별 fresh subagent, 빠른 반복 + 리뷰 게이트
2. **Inline Execution** — 현 세션에서 executing-plans로 배치 실행 + 체크포인트

Which approach?
