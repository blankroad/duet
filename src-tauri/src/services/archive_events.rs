//! 아카이브 해제 알림 — 해제는 끝났지만 일부 항목을 건너뛰었거나 이름을 바꾼 경우.
//!
//! 해제(task)와 내부 보기(browse) 모두 이 이벤트로 알린다. 실패는 기존 오류 경로
//! (`TaskChange::Failed` / command 오류)를 그대로 쓴다.

use crate::core::archive_here::ExtractHereSummary;
use crate::core::tar_unpack::UnpackReport;
use crate::types::Location;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// 목록에 실어 보낼 이름 수 상한 — 링크가 수천 개인 아카이브도 이벤트는 작게.
const SAMPLE: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ArchiveNoticeEvent {
    /// 아카이브 파일 이름 (표시용).
    pub archive_name: String,
    /// 만들 수 없어 건너뛴 심볼릭 링크 — 앞쪽 최대 20개.
    pub skipped_links: Vec<String>,
    pub skipped_links_count: u32,
    /// 이름을 바꿔 푼 항목(원래 이름) — 이 OS 에서 쓸 수 없는 글자를 `_` 로 바꿨거나, 앞 항목과
    /// 이름이 겹쳐(대소문자만 다름 등) `이름 (2)` 로 둘 다 남긴 경우. 앞쪽 최대 20개.
    pub renamed: Vec<String>,
    pub renamed_count: u32,
}

impl ArchiveNoticeEvent {
    /// 알릴 것이 없으면 None.
    pub fn from_report(archive_name: &str, report: &UnpackReport) -> Option<Self> {
        if report.skipped_links.is_empty() && report.renamed.is_empty() {
            return None;
        }
        let sample = |v: &[String]| v.iter().take(SAMPLE).cloned().collect();
        Some(Self {
            archive_name: archive_name.to_string(),
            skipped_links: sample(&report.skipped_links),
            skipped_links_count: u32::try_from(report.skipped_links.len()).unwrap_or(u32::MAX),
            renamed: sample(&report.renamed),
            renamed_count: u32::try_from(report.renamed.len()).unwrap_or(u32::MAX),
        })
    }
}

/// "여기에 압축 풀기" 결과 — 이름을 바꿔 놓았거나 교체·건너뛴 항목, 남은 준비 폴더가
/// 있을 때만 보낸다. 프론트가 같은 일괄의 결과를 모아 알림 하나로 보여준다.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ExtractHereNoticeEvent {
    /// 아카이브가 있는(= 풀린) 폴더.
    pub archive_dir: Location,
    pub summary: ExtractHereSummary,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_report_sends_nothing() {
        assert!(ArchiveNoticeEvent::from_report("a.tar.gz", &UnpackReport::default()).is_none());
    }

    #[test]
    fn caps_the_name_lists_but_keeps_counts() {
        let report = UnpackReport {
            skipped_links: (0..50).map(|i| format!("l{i}")).collect(),
            renamed: vec!["a:b".into()],
        };
        let ev = ArchiveNoticeEvent::from_report("a.tar.gz", &report).unwrap();
        assert_eq!(ev.skipped_links.len(), SAMPLE);
        assert_eq!(ev.skipped_links_count, 50);
        assert_eq!(ev.renamed_count, 1);
    }
}
