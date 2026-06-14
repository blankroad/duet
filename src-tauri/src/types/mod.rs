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
        /// 연결 소켓의 `getpeername()` IP. 같은-호스트 판정용.
        /// specta는 IpAddr를 String으로 표현 (impls.rs `impl_as!` 참조).
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

/// 파일시스템 항목 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    /// 일반 파일.
    File,
    /// 디렉토리.
    Dir,
    /// 심볼릭 링크 (target 정보는 별도 메타데이터).
    Symlink,
    /// 디바이스, FIFO, 소켓 등 위 셋이 아닌 것.
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

/// 삭제 모드.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DeleteMode {
    /// 휴지통 이동 (디폴트). undo 가능.
    Trash,
    /// 영구 삭제. 설정에서 명시적으로 활성화 + 단어 타이핑 확인 필요. undo 불가.
    Permanent,
}

/// 단일 항목의 stat — list 의 Entry 와 분리 (이름은 호출자가 알고 있음).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct EntryMeta {
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub modified_ms: Option<i64>,
    pub permissions: Option<u32>,
}

/// 미리보기 데이터 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum PreviewKind {
    /// utf8 텍스트 — `text` 채워짐.
    Text,
    /// 이미지 — `bytes_base64` + `mime` 채워짐.
    Image,
    /// utf8 디코드 실패 (바이너리). 본문 없음.
    Binary,
    /// size cap 초과. 본문 없음 (`total_size` 만).
    TooLarge,
    /// PDF — `mime` 채워짐, 프론트가 `duet-preview://` 로 스트리밍 렌더.
    Pdf,
    /// 오디오 — `mime` 채워짐, 스트리밍.
    Audio,
    /// 비디오 — `mime` 채워짐, 스트리밍.
    Video,
}

/// `fs_read_preview` 응답. 미리보기 패널 렌더용.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PreviewData {
    pub kind: PreviewKind,
    /// `Text` 일 때 본문 (cap 이내).
    pub text: Option<String>,
    /// `Image` 일 때 base64 인코딩 원본 바이트.
    pub bytes_base64: Option<String>,
    /// `Image` 일 때 data URL 용 MIME (예: `image/png`).
    pub mime: Option<String>,
    /// 본문이 cap 으로 잘렸는지 (현재는 cap 초과 시 TooLarge 라 항상 false, 향후 streaming 대비).
    pub truncated: bool,
    /// 실제 파일 크기 (bytes).
    pub total_size: u64,
}

/// `trash()` 결과 — 어디로 갔는지. undo 시 복원 정보.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TrashLocation {
    /// 로컬 trash crate 의 native id (OS 휴지통). MVP-2 macOS 는 빈 문자열 가능.
    Local { trash_id: String },
    /// 원격 ~/.duet-trash/<batch>/<original-path>/
    Remote { trash_path: PathBuf },
}
