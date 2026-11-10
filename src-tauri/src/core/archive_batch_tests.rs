//! `core::archive_batch` 테스트 — 실제 temp 폴더 위에서 계획·실행·undo.
use super::*;
use crate::core::archive::extract_execute;
use crate::core::ops::OpCtx;
use crate::core::undo::{undo_with_fixture, UndoKind};
use crate::fs::LocalFs;
use crate::services::journal::UndoAction;
use crate::types::{ConnectionId, Location, SourceId};
use std::io::Write as _;
use tokio_util::sync::CancellationToken;

async fn mk_ctx(root: &Path) -> OpCtx {
    let settings = crate::services::settings::SettingsStore::load_from(&root.join("s.toml"))
        .await
        .unwrap();
    let journal = crate::services::journal::Journal::load_from(&root.join("j.jsonl"))
        .await
        .unwrap();
    OpCtx {
        settings,
        journal,
        pool: None,
        app: None,
    }
}

fn eref(dir: &Path, name: &str) -> EntryRef {
    EntryRef {
        location: Location {
            source: SourceId::Local,
            path: dir.to_path_buf(),
        },
        name: name.into(),
    }
}

fn write_zip(path: &Path, name: &str, data: &[u8]) {
    let f = std::fs::File::create(path).unwrap();
    let mut w = zip::ZipWriter::new(f);
    w.start_file(name, zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(data).unwrap();
    w.finish().unwrap();
}

fn write_targz(path: &Path, name: &str, data: &[u8]) {
    let f = std::fs::File::create(path).unwrap();
    let gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
    let mut b = tar::Builder::new(gz);
    let mut h = tar::Header::new_gnu();
    h.set_size(data.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    b.append_data(&mut h, name, data).unwrap();
    b.into_inner().unwrap().finish().unwrap();
}

/// 작업 폴더(ctx 파일과 분리) 생성.
fn work_dir(root: &Path) -> PathBuf {
    let w = root.join("work");
    std::fs::create_dir(&w).unwrap();
    w
}

fn plans(items: &[ExtractPlanItem]) -> Vec<&ExtractPlan> {
    items.iter().map(|i| i.plan.as_ref().unwrap()).collect()
}

/// `a.zip` + `a.tar.gz` — 같은 일괄의 두 결과가 같은 폴더를 노리지 않는다 (교체/둘 다 유지 무관).
#[tokio::test]
async fn same_stem_in_one_batch_gets_distinct_dests() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    write_zip(&work.join("a.zip"), "z.txt", b"zip");
    write_targz(&work.join("a.tar.gz"), "t.txt", b"tgz");
    for keep_both in [false, true] {
        let items = extract_plan_batch(
            &LocalFs::new(),
            vec![eref(&work, "a.zip"), eref(&work, "a.tar.gz")],
            keep_both,
        )
        .await;
        let p = plans(&items);
        assert_eq!(p[0].dest_dir, work.join("a"));
        assert_eq!(p[1].dest_dir, work.join("a (2)"));
        assert!(!p[0].conflict && !p[1].conflict);
        assert!(
            p[0].keep_both && p[1].keep_both,
            "fresh names reserve at execute"
        );
    }
}

/// 회귀: 예전엔 `a.zip` + `a.tar.gz` 가 둘 다 `a/` 를 계획해 두 번째가 첫 번째 결과를
/// 백업으로 밀어냈다. 이제 둘 다 실행해도 각자 폴더, 백업 없음, journal 2개.
#[tokio::test]
async fn same_stem_batch_executes_into_two_folders_without_backup() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    write_zip(&work.join("a.zip"), "z.txt", b"zip");
    write_targz(&work.join("a.tar.gz"), "t.txt", b"tgz");
    let ctx = mk_ctx(root.path()).await;
    let local = LocalFs::new();
    let items = extract_plan_batch(
        &local,
        vec![eref(&work, "a.zip"), eref(&work, "a.tar.gz")],
        false,
    )
    .await;
    for it in &items {
        let (entry, _) = extract_execute(
            &local,
            it.plan.clone().unwrap(),
            None,
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        match entry.undo {
            UndoAction::UndoCopy {
                backups_to_restore, ..
            } => assert!(backups_to_restore.is_empty()),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(std::fs::read(work.join("a").join("z.txt")).unwrap(), b"zip");
    assert_eq!(
        std::fs::read(work.join("a (2)").join("t.txt")).unwrap(),
        b"tgz"
    );
    assert!(!work.join("a").join("t.txt").exists());
    assert_eq!(ctx.journal.history(10).await.len(), 2);
    let names: Vec<String> = std::fs::read_dir(&work)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!names.iter().any(|n| n.contains(".bak")), "{names:?}");
}

/// TOCTOU: "둘 다 유지" 계획이 `a (2)` 를 골랐는데 실행 전에 `a (2)` 가 생기면 `a (3)` 으로,
/// `a (2)` 는 그대로, 백업 없음.
#[tokio::test]
async fn keep_both_reserves_at_execute_when_planned_name_got_taken() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    write_zip(&work.join("a.zip"), "new.txt", b"new");
    std::fs::create_dir(work.join("a")).unwrap();
    let ctx = mk_ctx(root.path()).await;
    let local = LocalFs::new();
    let items = extract_plan_batch(&local, vec![eref(&work, "a.zip")], true).await;
    let plan = items[0].plan.clone().unwrap();
    assert_eq!(plan.dest_dir, work.join("a (2)"));
    assert!(plan.keep_both);

    std::fs::create_dir(work.join("a (2)")).unwrap();
    std::fs::write(work.join("a (2)").join("mine.txt"), b"mine").unwrap();
    let (entry, _) = extract_execute(&local, plan, None, &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(work.join("a (3)").join("new.txt")).unwrap(),
        b"new"
    );
    assert_eq!(
        std::fs::read(work.join("a (2)").join("mine.txt")).unwrap(),
        b"mine"
    );
    assert!(!work.join("a (2)").join("new.txt").exists());
    match entry.undo {
        UndoAction::UndoCopy {
            copied,
            backups_to_restore,
            ..
        } => {
            assert_eq!(copied, vec![work.join("a (3)")]);
            assert!(backups_to_restore.is_empty());
        }
        other => panic!("{other:?}"),
    }
}

/// TOCTOU: 충돌 없이 계획된 항목(다이얼로그를 거치지 않음)도 실행 전에 그 이름이 생기면
/// 백업하지 않고 다음 번호로.
#[tokio::test]
async fn unconflicted_item_never_backs_up_a_name_that_appeared_later() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    write_zip(&work.join("a.zip"), "new.txt", b"new");
    let ctx = mk_ctx(root.path()).await;
    let local = LocalFs::new();
    let items = extract_plan_batch(&local, vec![eref(&work, "a.zip")], false).await;
    let plan = items[0].plan.clone().unwrap();
    assert!(!plan.conflict && plan.keep_both);

    std::fs::create_dir(work.join("a")).unwrap();
    std::fs::write(work.join("a").join("mine.txt"), b"mine").unwrap();
    extract_execute(&local, plan, None, &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(work.join("a").join("mine.txt")).unwrap(),
        b"mine"
    );
    assert!(!work.join("a").join("new.txt").exists());
    assert_eq!(
        std::fs::read(work.join("a (2)").join("new.txt")).unwrap(),
        b"new"
    );
}

/// 대소문자만 다른 stem 도 같은 폴더로 본다 (대소문자 무시 볼륨에서 서로 백업하지 않게).
#[tokio::test]
async fn case_only_different_stems_are_treated_as_same_name() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    write_zip(&work.join("Data.zip"), "x", b"1");
    write_targz(&work.join("data.tar.gz"), "y", b"2");
    let items = extract_plan_batch(
        &LocalFs::new(),
        vec![eref(&work, "Data.zip"), eref(&work, "data.tar.gz")],
        false,
    )
    .await;
    let p = plans(&items);
    assert_eq!(p[0].dest_dir, work.join("Data"));
    assert_eq!(p[1].dest_dir, work.join("data (2)"));
}

/// 디스크에 `a/` 가 있고 "둘 다 유지" → `a (2)`, 충돌 아님. `a (2)` 도 있으면 `a (3)`.
#[tokio::test]
async fn existing_dest_with_keep_both_picks_next_free_name() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    write_zip(&work.join("a.zip"), "z.txt", b"zip");
    std::fs::create_dir(work.join("a")).unwrap();
    let items = extract_plan_batch(&LocalFs::new(), vec![eref(&work, "a.zip")], true).await;
    let p = plans(&items);
    assert_eq!(p[0].dest_dir, work.join("a (2)"));
    assert!(!p[0].conflict);

    std::fs::create_dir(work.join("a (2)")).unwrap();
    let items = extract_plan_batch(&LocalFs::new(), vec![eref(&work, "a.zip")], true).await;
    assert_eq!(plans(&items)[0].dest_dir, work.join("a (3)"));
}

/// 단일 파일(.gz) "둘 다 유지" 는 `log (2).txt` 로 풀리고 기존 `log.txt` 는 그대로다.
#[tokio::test]
async fn single_file_keep_both_writes_numbered_file_and_keeps_existing() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    {
        let f = std::fs::File::create(work.join("log.txt.gz")).unwrap();
        let mut gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        gz.write_all(b"new").unwrap();
        gz.finish().unwrap();
    }
    std::fs::write(work.join("log.txt"), b"old").unwrap();
    let ctx = mk_ctx(root.path()).await;
    let local = LocalFs::new();
    let items = extract_plan_batch(&local, vec![eref(&work, "log.txt.gz")], true).await;
    let plan = items[0].plan.clone().unwrap();
    assert_eq!(plan.dest_dir, work.join("log (2).txt"));
    extract_execute(&local, plan, None, &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(std::fs::read(work.join("log.txt")).unwrap(), b"old");
    assert_eq!(std::fs::read(work.join("log (2).txt")).unwrap(), b"new");
}

/// 디스크에 `a/` 가 있고 "교체" → 충돌 표시, 실행이 기존을 백업, Ctrl+Z 가 복원.
#[tokio::test]
async fn existing_dest_with_replace_backs_up_and_undo_restores() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    write_zip(&work.join("a.zip"), "new.txt", b"new");
    std::fs::create_dir(work.join("a")).unwrap();
    std::fs::write(work.join("a").join("old.txt"), b"old").unwrap();

    let ctx = mk_ctx(root.path()).await;
    let local = LocalFs::new();
    let items = extract_plan_batch(&local, vec![eref(&work, "a.zip")], false).await;
    let plan = items[0].plan.clone().unwrap();
    assert_eq!(plan.dest_dir, work.join("a"));
    assert!(plan.conflict && !plan.keep_both);

    let (entry, _) = extract_execute(&local, plan, None, &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(work.join("a").join("new.txt")).unwrap(),
        b"new"
    );
    assert!(!work.join("a").join("old.txt").exists());
    let backups: Vec<_> = std::fs::read_dir(&work)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("a.bak."))
        .collect();
    assert_eq!(backups.len(), 1, "existing folder moved to a backup");

    let outcome = undo_with_fixture(&entry).await;
    assert!(matches!(outcome.kind, UndoKind::Ok), "{outcome:?}");
    assert_eq!(
        std::fs::read(work.join("a").join("old.txt")).unwrap(),
        b"old"
    );
    assert!(!work.join("a").join("new.txt").exists());
}

/// 지원 안 함·없는 파일·폴더인 항목은 그 항목만 에러, 나머지는 계획된다 (순서 보존).
#[tokio::test]
async fn bad_items_get_per_item_errors_and_others_are_planned() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    write_zip(&work.join("good.zip"), "g", b"g");
    std::fs::write(work.join("notes.txt"), b"plain").unwrap();
    std::fs::create_dir(work.join("folder.zip")).unwrap();
    write_targz(&work.join("ok.tar.gz"), "o", b"o");

    let items = extract_plan_batch(
        &LocalFs::new(),
        vec![
            eref(&work, "good.zip"),
            eref(&work, "notes.txt"),
            eref(&work, "missing.zip"),
            eref(&work, "folder.zip"),
            eref(&work, "ok.tar.gz"),
        ],
        false,
    )
    .await;
    let names: Vec<&str> = items.iter().map(|i| i.archive.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "good.zip",
            "notes.txt",
            "missing.zip",
            "folder.zip",
            "ok.tar.gz"
        ]
    );
    for (i, ok) in [true, false, false, false, true].into_iter().enumerate() {
        assert_eq!(items[i].plan.is_some(), ok, "{}", items[i].archive.name);
        assert_eq!(items[i].error.is_some(), !ok, "{}", items[i].archive.name);
    }
    assert!(matches!(items[2].error, Some(DuetError::NotFound(_))));
    assert_eq!(items[4].plan.as_ref().unwrap().dest_dir, work.join("ok"));
}

/// 원격처럼 보이는 fs — 메타데이터는 로컬 temp 를 읽되 source 는 SSH.
/// (계획 단계는 metadata/join 만 쓴다.)
struct RemoteView(LocalFs);

fn ssh_source() -> SourceId {
    SourceId::Ssh {
        connection_id: ConnectionId("c1".into()),
        host_ip: std::net::IpAddr::from([127, 0, 0, 1]),
        user: "u".into(),
    }
}

#[async_trait::async_trait]
impl FileSystem for RemoteView {
    fn source_id(&self) -> SourceId {
        ssh_source()
    }
    fn join(&self, base: &Path, name: &str) -> PathBuf {
        base.join(name)
    }
    async fn list(&self, p: &Path) -> Result<Vec<crate::types::Entry>, DuetError> {
        self.0.list(p).await
    }
    async fn metadata(&self, p: &Path) -> Result<crate::types::EntryMeta, DuetError> {
        self.0.metadata(p).await
    }
    async fn rename(&self, _: &Path, _: &Path) -> Result<(), DuetError> {
        unimplemented!()
    }
    async fn mkdir(&self, _: &Path) -> Result<(), DuetError> {
        unimplemented!()
    }
    async fn trash(&self, _: &Path, _: &str) -> Result<crate::types::TrashLocation, DuetError> {
        unimplemented!()
    }
    async fn remove(&self, _: &Path) -> Result<(), DuetError> {
        unimplemented!()
    }
    async fn restore_from_trash(
        &self,
        _: &crate::types::TrashLocation,
        _: &Path,
    ) -> Result<(), DuetError> {
        unimplemented!()
    }
    async fn read_full(&self, _: &Path) -> Result<Vec<u8>, DuetError> {
        unimplemented!()
    }
    async fn write_full(&self, _: &Path, _: &[u8]) -> Result<(), DuetError> {
        unimplemented!()
    }
    async fn open_read(
        &self,
        _: &Path,
        _: u64,
    ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        unimplemented!()
    }
    async fn open_write(
        &self,
        _: &Path,
        _: u64,
    ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        unimplemented!()
    }
}

/// 원격 일괄에서 7z/rar/단일 파일은 그 항목만 NotSupported, zip·tar 는 계획된다.
/// 다른 source 의 항목이 섞이면 그 항목만 에러.
#[tokio::test]
async fn remote_unsupported_formats_fail_per_item() {
    let root = tempfile::tempdir().unwrap();
    let work = work_dir(root.path());
    for n in ["a.zip", "b.7z", "c.rar", "d.txt.gz", "e.tar.gz"] {
        std::fs::write(work.join(n), b"x").unwrap();
    }
    let remote = |name: &str| EntryRef {
        location: Location {
            source: ssh_source(),
            path: work.clone(),
        },
        name: name.into(),
    };
    let fs = RemoteView(LocalFs::new());
    let items = extract_plan_batch(
        &fs,
        vec![
            remote("a.zip"),
            remote("b.7z"),
            remote("c.rar"),
            remote("d.txt.gz"),
            remote("e.tar.gz"),
            eref(&work, "a.zip"),
        ],
        false,
    )
    .await;
    assert!(items[0].plan.is_some());
    for i in 1..=3 {
        assert!(
            matches!(items[i].error, Some(DuetError::NotSupported(_))),
            "{}: {:?}",
            items[i].archive.name,
            items[i].error
        );
    }
    assert!(items[4].plan.is_some());
    assert!(matches!(items[5].error, Some(DuetError::Io(_))));
}
