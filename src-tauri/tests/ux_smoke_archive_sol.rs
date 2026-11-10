//! Baseline smoke: real local extraction and journal undo, exclusively in tempdirs.
#[path = "support/undo_fixture.rs"]
mod undo_fixture;

use duet_lib::core::{
    archive::{extract_execute, extract_plan},
    ops::OpCtx,
    undo::UndoKind,
};
use duet_lib::fs::LocalFs;
use duet_lib::services::{
    journal::{Journal, JournalEntry, UndoAction},
    settings::SettingsStore,
};
use duet_lib::types::{DuetError, EntryRef, Location, SourceId};
use std::{io::Write, path::Path};
use tokio_util::sync::CancellationToken;

fn entry(root: &Path, name: &str) -> EntryRef {
    EntryRef {
        location: Location {
            source: SourceId::Local,
            path: root.into(),
        },
        name: name.into(),
    }
}
async fn ctx(root: &Path) -> OpCtx {
    OpCtx {
        journal: Journal::load_from(&root.join("journal.jsonl"))
            .await
            .unwrap(),
        settings: SettingsStore::load_from(&root.join("settings.toml"))
            .await
            .unwrap(),
        pool: None,
        app: None,
    }
}
fn zip(root: &Path, name: &str) {
    let mut w = zip::ZipWriter::new(std::fs::File::create(root.join(name)).unwrap());
    w.start_file("zip.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    w.write_all(b"zip payload").unwrap();
    w.finish().unwrap();
}
fn gzip(root: &Path, name: &str, tar: bool) {
    let encoder = flate2::write::GzEncoder::new(
        std::fs::File::create(root.join(name)).unwrap(),
        flate2::Compression::default(),
    );
    if tar {
        let mut w = tar::Builder::new(encoder);
        let bytes = b"tar payload";
        let mut h = tar::Header::new_gnu();
        h.set_size(bytes.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        w.append_data(&mut h, "tar.txt", &bytes[..]).unwrap();
        w.into_inner().unwrap().finish().unwrap();
    } else {
        let mut w = encoder;
        w.write_all(b"gzip payload").unwrap();
        w.finish().unwrap();
    }
}
fn backup(e: &JournalEntry) -> &Path {
    let UndoAction::UndoCopy {
        backups_to_restore, ..
    } = &e.undo
    else {
        panic!("expected UndoCopy")
    };
    assert_eq!(backups_to_restore.len(), 1);
    let p = &backups_to_restore[0].backup_path;
    assert!(p.file_name().unwrap().to_string_lossy().contains(".bak"));
    p
}

#[tokio::test]
async fn single_zip_extracts_to_stem_folder_and_undo_removes_it() {
    let t = tempfile::tempdir().unwrap();
    let c = ctx(t.path()).await;
    zip(t.path(), "data.zip");
    let p = extract_plan(&LocalFs, entry(t.path(), "data.zip"))
        .await
        .unwrap();
    assert_eq!(p.dest_dir, t.path().join("data"));
    assert!(!p.conflict);
    let (e, _) = extract_execute(&LocalFs, p, None, &c, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(t.path().join("data/zip.txt")).unwrap(),
        b"zip payload"
    );
    assert!(!t.path().join("zip.txt").exists());
    assert_eq!(undo_fixture::undo_tmp(&e).await.kind, UndoKind::Ok);
    assert!(!t.path().join("data").exists());
    assert!(t.path().join("data.zip").exists());
}

#[tokio::test]
async fn existing_stem_is_backed_up_without_execute_confirmation_and_undo_restores() {
    let t = tempfile::tempdir().unwrap();
    let c = ctx(t.path()).await;
    zip(t.path(), "data.zip");
    std::fs::create_dir(t.path().join("data")).unwrap();
    std::fs::write(t.path().join("data/original.txt"), b"original").unwrap();
    let p = extract_plan(&LocalFs, entry(t.path(), "data.zip"))
        .await
        .unwrap();
    assert!(p.conflict);
    let (e, _) = extract_execute(&LocalFs, p, None, &c, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(backup(&e).join("original.txt")).unwrap(),
        b"original"
    );
    assert!(!t.path().join("data/original.txt").exists());
    assert_eq!(undo_fixture::undo_tmp(&e).await.kind, UndoKind::Ok);
    assert_eq!(
        std::fs::read(t.path().join("data/original.txt")).unwrap(),
        b"original"
    );
    assert!(!t.path().join("data/zip.txt").exists());
    assert!(!backup(&e).exists());
}

#[tokio::test]
async fn upfront_same_stem_plans_collide_when_executed_sequentially() {
    let t = tempfile::tempdir().unwrap();
    let c = ctx(t.path()).await;
    zip(t.path(), "a.zip");
    gzip(t.path(), "a.tar.gz", true);
    let first = extract_plan(&LocalFs, entry(t.path(), "a.zip"))
        .await
        .unwrap();
    let second = extract_plan(&LocalFs, entry(t.path(), "a.tar.gz"))
        .await
        .unwrap();
    assert_eq!(first.dest_dir, second.dest_dir);
    assert!(!first.conflict && !second.conflict);
    let (e1, _) = extract_execute(&LocalFs, first, None, &c, CancellationToken::new())
        .await
        .unwrap();
    let (e2, _) = extract_execute(&LocalFs, second, None, &c, CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(e1.id, e2.id);
    assert_eq!(
        std::fs::read(t.path().join("a/tar.txt")).unwrap(),
        b"tar payload"
    );
    assert!(!t.path().join("a/zip.txt").exists());
    assert_eq!(
        std::fs::read(backup(&e2).join("zip.txt")).unwrap(),
        b"zip payload"
    );
    assert_eq!(undo_fixture::undo_tmp(&e2).await.kind, UndoKind::Ok);
    assert_eq!(
        std::fs::read(t.path().join("a/zip.txt")).unwrap(),
        b"zip payload"
    );
    assert_eq!(undo_fixture::undo_tmp(&e1).await.kind, UndoKind::Ok);
}

#[tokio::test]
async fn single_gzip_extracts_directly_to_file() {
    let t = tempfile::tempdir().unwrap();
    let c = ctx(t.path()).await;
    gzip(t.path(), "log.txt.gz", false);
    let p = extract_plan(&LocalFs, entry(t.path(), "log.txt.gz"))
        .await
        .unwrap();
    assert_eq!(p.dest_dir, t.path().join("log.txt"));
    let (e, _) = extract_execute(&LocalFs, p, None, &c, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(t.path().join("log.txt")).unwrap(),
        b"gzip payload"
    );
    assert_eq!(undo_fixture::undo_tmp(&e).await.kind, UndoKind::Ok);
    assert!(!t.path().join("log.txt").exists());
}

#[tokio::test]
async fn non_archive_and_remote_unsupported_are_rejected_before_io() {
    let t = tempfile::tempdir().unwrap();
    assert!(
        matches!(extract_plan(&LocalFs, entry(t.path(), "notes.txt")).await, Err(DuetError::Io(m)) if m.contains("unsupported archive"))
    );
    for name in ["a.7z", "a.rar", "a.gz"] {
        let mut e = entry(t.path(), name);
        e.location.source = SourceId::Ssh {
            connection_id: duet_lib::types::ConnectionId("no-connection".into()),
            host_ip: "127.0.0.1".parse().unwrap(),
            user: "fixture".into(),
        };
        assert!(matches!(
            extract_plan(&LocalFs, e).await,
            Err(DuetError::NotSupported(_))
        ));
    }
}
