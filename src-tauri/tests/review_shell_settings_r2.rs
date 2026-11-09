//! shell-settings R2 교차 검토(opus) — shell-settings-01 독립 재현.
//!
//! journal append 는 레코드와 `\n` 을 두 번의 write 로 나눠 쓴다(`journal.rs` `append`).
//! 첫 write 뒤에 프로세스가 끊기면(강제 종료·전원) 줄바꿈 없는 마지막 줄이 남는다.
//! 그 자체는 다음 부팅에서 정상 파싱되지만, **그 뒤 첫 작업의 기록이 같은 줄에 이어 붙어**
//! `{…}{…}` 한 줄이 되고, 그다음 부팅부터 `read_tail` 이 Err → `lib.rs` `.expect("journal load")`.

use duet_lib::services::journal::{Journal, OpKind, UndoAction};
use duet_lib::types::{Location, SourceId};
use std::path::PathBuf;
use tempfile::tempdir;

fn op() -> OpKind {
    OpKind::PermanentDelete {
        count: 1,
        location: Location {
            source: SourceId::Local,
            path: PathBuf::from("/tmp/x"),
        },
    }
}

#[tokio::test]
async fn journal_survives_append_interrupted_before_newline() {
    let d = tempdir().unwrap();
    let p = d.path().join("journal.jsonl");

    // 1) 정상 기록 하나.
    let j = Journal::load_from(&p).await.unwrap();
    j.push(op(), UndoAction::Irreversible).await.unwrap();
    // 2) 다음 기록이 "레코드는 썼고 \n 은 못 쓴" 상태로 끊김을 흉내 — 마지막 줄바꿈 제거.
    let text = std::fs::read_to_string(&p).unwrap();
    std::fs::write(&p, text.trim_end_matches('\n')).unwrap();

    // 3) 재시작: 아직은 정상(줄바꿈 없는 마지막 줄도 파싱됨).
    let j = Journal::load_from(&p)
        .await
        .expect("missing trailing newline alone is fine");
    // 4) 사용자가 작업 하나 더 → 같은 줄에 이어 붙음.
    j.push(op(), UndoAction::Irreversible).await.unwrap();

    // 5) 다음 재시작 — 여기서 Err 면 앱이 창도 못 띄운다.
    let r = Journal::load_from(&p).await;
    assert!(
        r.is_ok(),
        "journal became unreadable after an interrupted append: {:?}",
        r.err()
    );
}
