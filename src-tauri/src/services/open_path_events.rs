//! 단일 인스턴스 forward "이 폴더 열기" 이벤트.
//!
//! duet 이 이미 실행 중일 때 폴더 더블클릭 / "Open in duet" 으로 새 인스턴스가 뜨면
//! `tauri-plugin-single-instance` 가 그 인자를 기존 인스턴스로 forward 한다. 백엔드는
//! 인자에서 디렉토리 경로를 뽑아 이 이벤트로 프론트엔드에 전달하고, 프론트는 활성
//! 패널에 새 탭으로 그 폴더를 연다. (Windows 전용 기능이지만 이벤트 타입 자체는
//! 모든 OS 에서 컴파일된다 — 무해.)

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// 기존 창에서 새 탭으로 열 디렉토리 경로 (절대, UTF-8 문자열).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct OpenPathEvent {
    pub path: String,
}
