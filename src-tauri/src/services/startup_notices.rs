//! 시작할 때 저장 파일 문제를 고치고 넘어간 내역 — 창이 뜬 뒤 프론트가 한 번 가져가 알린다.
//!
//! 각 store 의 `load_from` 이 깨진 파일을 만나면 패닉 대신 기본값으로 시작하고
//! [`StartupNotice`] 를 남긴다(`load_notice()`). `lib.rs` 가 모아 [`StartupNotices`] 로
//! manage 하고, 프론트는 `startup_notices_take` 로 가져가 경고 토스트를 띄운다.
//! 이벤트가 아니라 pull 인 이유: 이벤트는 프론트가 구독하기 전에 쏘면 사라진다.

use crate::fs::persist::Quarantined;
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use std::sync::Mutex;

/// 무엇을 했는지.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartupNoticeKind {
    /// 파일을 읽을 수 없어 `backup` 으로 옮겨 두고 기본값으로 시작했다.
    Reset { backup: PathBuf },
    /// 읽을 수 없는 줄만 건너뛰고 나머지는 살렸다(journal). 원본 사본은 `backup`.
    SkippedLines { count: u32, backup: Option<PathBuf> },
}

/// 시작 알림 한 건.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct StartupNotice {
    /// 문제가 있던 파일.
    pub file: PathBuf,
    pub action: StartupNoticeKind,
    /// 파싱 오류 원문 — 알림 "자세히"용.
    pub detail: String,
}

impl From<&Quarantined> for StartupNotice {
    fn from(q: &Quarantined) -> Self {
        Self {
            file: q.original.clone(),
            action: StartupNoticeKind::Reset {
                backup: q.backup.clone(),
            },
            detail: q.reason.clone(),
        }
    }
}

/// 시작 알림 모음 (managed state). 프론트가 한 번 가져가면 비운다.
#[derive(Debug, Default)]
pub struct StartupNotices(Mutex<Vec<StartupNotice>>);

impl StartupNotices {
    pub fn new(notices: Vec<StartupNotice>) -> Self {
        Self(Mutex::new(notices))
    }

    /// 모아 둔 알림을 꺼내고 비운다. (창 새로고침 시 같은 알림을 두 번 보이지 않게.)
    pub fn take(&self) -> Vec<StartupNotice> {
        match self.0.lock() {
            Ok(mut v) => std::mem::take(&mut *v),
            Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_drains_once() {
        let n = StartupNotices::new(vec![StartupNotice {
            file: PathBuf::from("a"),
            action: StartupNoticeKind::SkippedLines {
                count: 1,
                backup: None,
            },
            detail: String::new(),
        }]);
        assert_eq!(n.take().len(), 1);
        assert!(n.take().is_empty());
    }
}
