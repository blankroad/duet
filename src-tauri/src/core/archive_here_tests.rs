//! `core::archive_here` 테스트 — 실제 temp 폴더, OS 휴지통 대신 fixture 휴지통.
use super::*;
use crate::core::undo::{undo_with_fixture, UndoKind};
use crate::fs::LocalFs;
use crate::types::{Entry, EntryMeta, TrashLocation};
use async_trait::async_trait;
use std::io::Write as _;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

// ---------- fixture fs ----------

/// LocalFs 위임 + 휴지통은 temp 안 폴더로(호출 기록) + 특정 이름으로의 rename 실패 주입.
/// 영구 삭제(`remove`)는 부르면 panic (CLAUDE.md §3).
#[derive(Clone)]
struct HereFs {
    trash_dir: PathBuf,
    trashed: Arc<Mutex<Vec<PathBuf>>>,
    fail_rename_to: Option<String>,
    /// 이 이름을 예약(create_new_file)한 직후 다른 프로그램이 내용을 쓴 것처럼 흉내.
    scribble_after_reserve: Option<String>,
    /// true 면 휴지통이 실패한다 (남은 준비 폴더 보고·부분 되돌림 확인용).
    fail_trash: bool,
}

impl HereFs {
    fn new(root: &Path) -> Self {
        let trash_dir = root.join("fixture-trash");
        std::fs::create_dir_all(&trash_dir).unwrap();
        Self {
            trash_dir,
            trashed: Arc::default(),
            fail_rename_to: None,
            scribble_after_reserve: None,
            fail_trash: false,
        }
    }
    fn trashed(&self) -> Vec<PathBuf> {
        self.trashed.lock().unwrap().clone()
    }
}

#[async_trait]
impl FileSystem for HereFs {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }
    async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
        LocalFs.list(p).await
    }
    async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        LocalFs.metadata(p).await
    }
    async fn symlink_metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        LocalFs.symlink_metadata(p).await
    }
    async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
        let name = t.file_name().map(|n| n.to_string_lossy().into_owned());
        if name.is_some() && name == self.fail_rename_to {
            return Err(DuetError::Io("fixture: injected rename failure".into()));
        }
        LocalFs.rename(f, t).await
    }
    async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
        LocalFs.mkdir(p).await
    }
    async fn create_new_file(&self, p: &Path) -> Result<(), DuetError> {
        LocalFs.create_new_file(p).await?;
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned());
        if name.is_some() && name == self.scribble_after_reserve {
            std::fs::write(p, b"written by another program").unwrap();
        }
        Ok(())
    }
    async fn remove_empty_dir(&self, p: &Path) -> Result<(), DuetError> {
        LocalFs.remove_empty_dir(p).await
    }
    async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        if self.fail_trash {
            return Err(DuetError::PermissionDenied("fixture: trash refused".into()));
        }
        let mut log = self.trashed.lock().unwrap();
        let dest = self.trash_dir.join(format!("{}", log.len()));
        std::fs::rename(p, &dest).map_err(DuetError::from)?;
        log.push(p.to_path_buf());
        Ok(TrashLocation::Local {
            trash_id: dest.to_string_lossy().into_owned(),
        })
    }
    async fn remove(&self, p: &Path) -> Result<(), DuetError> {
        panic!("permanent removal forbidden: {}", p.display())
    }
    async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
        unimplemented!()
    }
    async fn read_full(&self, p: &Path) -> Result<Vec<u8>, DuetError> {
        LocalFs.read_full(p).await
    }
    async fn write_full(&self, p: &Path, b: &[u8]) -> Result<(), DuetError> {
        LocalFs.write_full(p, b).await
    }
    async fn open_read(
        &self,
        p: &Path,
        o: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        LocalFs.open_read(p, o).await
    }
    async fn open_write(
        &self,
        p: &Path,
        o: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        LocalFs.open_write(p, o).await
    }
}

/// journal 실패 때의 되돌림이 쓰는 fs — fixture 그대로 (OS 휴지통을 부르지 않는다).
struct HereResolver(HereFs);

#[async_trait]
impl FsResolver for HereResolver {
    async fn fs(&self, _: &SourceId) -> Result<Box<dyn FileSystem>, DuetError> {
        Ok(Box::new(self.0.clone()))
    }
}

// ---------- 도우미 ----------

struct Env {
    _t: tempfile::TempDir,
    work: PathBuf,
    ctx_dir: PathBuf,
    ctx: OpCtx,
    fs: HereFs,
    /// 되돌림용 fs — 기본은 `fs` 와 같은 설정.
    undo_fs: Option<HereFs>,
}

async fn env() -> Env {
    let t = tempfile::tempdir().unwrap();
    let work = t.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let c = t.path().join("ctx");
    std::fs::create_dir(&c).unwrap();
    let ctx = OpCtx {
        settings: crate::services::settings::SettingsStore::load_from(&c.join("s.toml"))
            .await
            .unwrap(),
        journal: crate::services::journal::Journal::load_from(&c.join("j.jsonl"))
            .await
            .unwrap(),
        pool: None,
        app: None,
    };
    let fs = HereFs::new(t.path());
    Env {
        _t: t,
        work,
        ctx_dir: c,
        ctx,
        fs,
        undo_fs: None,
    }
}

impl Env {
    async fn here(
        &self,
        name: &str,
        policy: ExtractConflict,
    ) -> Result<(JournalEntry, UnpackReport, ExtractHereSummary), DuetError> {
        self.here_pw(name, policy, None).await
    }
    async fn here_pw(
        &self,
        name: &str,
        policy: ExtractConflict,
        pw: Option<&str>,
    ) -> Result<(JournalEntry, UnpackReport, ExtractHereSummary), DuetError> {
        let archive = EntryRef {
            location: Location {
                source: SourceId::Local,
                path: self.work.clone(),
            },
            name: name.into(),
        };
        self.run(archive, policy, pw.map(str::to_owned), &[]).await
    }
    /// 엔진 호출 — 성공이면 (entry, report, summary).
    async fn run(
        &self,
        archive: EntryRef,
        policy: ExtractConflict,
        password: Option<String>,
        protect: &[PathBuf],
    ) -> Result<(JournalEntry, UnpackReport, ExtractHereSummary), DuetError> {
        let out = self.outcome(archive, policy, password, protect).await;
        out.result
            .map(|(entry, report)| (entry, report, out.summary))
    }
    async fn outcome(
        &self,
        archive: EntryRef,
        policy: ExtractConflict,
        password: Option<String>,
        protect: &[PathBuf],
    ) -> HereOutcome {
        let resolver = HereResolver(self.undo_fs.clone().unwrap_or_else(|| self.fs.clone()));
        extract_here_execute(
            &self.fs,
            HereRequest {
                archive,
                policy,
                password,
                protect,
            },
            &self.ctx,
            &resolver,
            CancellationToken::new(),
        )
        .await
    }
    /// journal 파일 자리를 폴더로 바꿔 다음 기록(push)이 실패하게 한다.
    fn break_journal(&self) {
        let j = self.ctx_dir.join("j.jsonl");
        let _ = std::fs::remove_file(&j);
        std::fs::create_dir(&j).unwrap();
    }
    fn work_names(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(&self.work)
            .unwrap()
            .map(|x| x.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }
    fn p(&self, rel: &str) -> PathBuf {
        rel.split('/').fold(self.work.clone(), |acc, c| acc.join(c))
    }
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.p(rel)).unwrap()
    }
    /// 작업 폴더에 준비 폴더가 남지 않았는지.
    fn assert_no_staging(&self) {
        for e in std::fs::read_dir(&self.work).unwrap() {
            let n = e.unwrap().file_name().to_string_lossy().into_owned();
            assert!(!n.starts_with(STAGING_PREFIX), "staging left: {n}");
        }
    }
}

/// (이름, 내용) 으로 zip. 이름이 `/` 로 끝나면 폴더.
fn write_zip(path: &Path, entries: &[(&str, &str)]) {
    let f = std::fs::File::create(path).unwrap();
    let mut w = zip::ZipWriter::new(f);
    for (name, data) in entries {
        if name.ends_with('/') {
            w.add_directory(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
        } else {
            w.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(data.as_bytes()).unwrap();
        }
    }
    w.finish().unwrap();
}

/// (이름, 내용) 파일만으로 tar.gz (중간 폴더는 경로로 생긴다).
fn write_targz(path: &Path, entries: &[(&str, &str)]) {
    let f = std::fs::File::create(path).unwrap();
    let gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
    let mut b = tar::Builder::new(gz);
    for (name, data) in entries {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, name, data.as_bytes()).unwrap();
    }
    b.into_inner().unwrap().finish().unwrap();
}

fn copied_of(entry: &JournalEntry) -> Vec<PathBuf> {
    match &entry.undo {
        UndoAction::UndoCopy { copied, .. } => copied.clone(),
        other => panic!("wrong undo kind: {other:?}"),
    }
}

// ---------- 1. 병합 + undo 는 자기 것만 ----------

#[tokio::test]
async fn two_archives_merge_into_one_folder_and_undo_removes_only_second() {
    let e = env().await;
    write_zip(&e.p("one.zip"), &[("photos/", ""), ("photos/a.jpg", "A")]);
    write_zip(&e.p("two.zip"), &[("photos/", ""), ("photos/b.jpg", "B")]);

    let (first, _, s1) = e.here("one.zip", ExtractConflict::KeepBoth).await.unwrap();
    assert_eq!(copied_of(&first), vec![e.p("photos")]);
    assert!(!s1.is_notable());
    let (second, _, s2) = e.here("two.zip", ExtractConflict::KeepBoth).await.unwrap();
    // 병합: 두 번째는 기존 photos/ 안에 b.jpg 만 새로 만든다.
    assert_eq!(copied_of(&second), vec![e.p("photos/b.jpg")]);
    assert!(s2.renamed.is_empty(), "folder merge is not a rename");
    assert_eq!(e.read("photos/a.jpg"), "A");
    assert_eq!(e.read("photos/b.jpg"), "B");
    e.assert_no_staging();
    // 원본 아카이브는 그대로.
    assert!(e.p("one.zip").is_file() && e.p("two.zip").is_file());

    let out = undo_with_fixture(&second).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert!(!e.p("photos/b.jpg").exists());
    assert_eq!(e.read("photos/a.jpg"), "A");
}

/// 회귀: `a.zip` + `a.tar.gz` 가 같은 맨 위 이름을 가지면 폴더는 병합, 파일은 둘 다 유지.
/// (예전 단일 해제는 둘 다 `a/` 를 계획해 두 번째가 첫 번째를 백업으로 밀어냈다.)
#[tokio::test]
async fn same_stem_archives_merge_dirs_and_keep_both_files() {
    let e = env().await;
    write_zip(
        &e.p("a.zip"),
        &[
            ("docs/", ""),
            ("docs/z.txt", "zip"),
            ("readme.txt", "from zip"),
        ],
    );
    write_targz(
        &e.p("a.tar.gz"),
        &[("docs/t.txt", "tgz"), ("readme.txt", "from tgz")],
    );
    e.here("a.zip", ExtractConflict::KeepBoth).await.unwrap();
    let (_, _, s) = e.here("a.tar.gz", ExtractConflict::KeepBoth).await.unwrap();
    assert_eq!(e.read("docs/z.txt"), "zip");
    assert_eq!(e.read("docs/t.txt"), "tgz");
    assert_eq!(e.read("readme.txt"), "from zip");
    assert_eq!(e.read("readme (2).txt"), "from tgz");
    assert_eq!(s.renamed.len(), 1);
    assert_eq!(s.renamed[0].to, "readme (2).txt");
    assert!(e.fs.trashed().is_empty(), "nothing left to trash");
    e.assert_no_staging();
}

// ---------- 2. KeepBoth ----------

#[tokio::test]
async fn keep_both_numbers_past_existing_names_and_leaves_originals() {
    let e = env().await;
    write_zip(&e.p("r.zip"), &[("readme.txt", "new")]);
    std::fs::write(e.p("readme.txt"), "old").unwrap();

    let (_, _, s) = e.here("r.zip", ExtractConflict::KeepBoth).await.unwrap();
    assert_eq!(e.read("readme.txt"), "old");
    assert_eq!(e.read("readme (2).txt"), "new");
    assert_eq!(s.renamed[0].from, "readme.txt");

    std::fs::remove_file(e.p("readme (2).txt")).unwrap();
    std::fs::write(e.p("readme (2).txt"), "taken").unwrap();
    e.here("r.zip", ExtractConflict::KeepBoth).await.unwrap();
    assert_eq!(e.read("readme.txt"), "old");
    assert_eq!(e.read("readme (2).txt"), "taken");
    assert_eq!(e.read("readme (3).txt"), "new");
}

// ---------- 3. Replace ----------

#[tokio::test]
async fn replace_backs_up_existing_and_undo_restores_it() {
    let e = env().await;
    write_zip(&e.p("r.zip"), &[("readme.txt", "new")]);
    std::fs::write(e.p("readme.txt"), "old").unwrap();

    let (entry, _, s) = e.here("r.zip", ExtractConflict::Replace).await.unwrap();
    assert_eq!(e.read("readme.txt"), "new");
    assert_eq!(s.replaced.len(), 1);
    let backup = s.replaced[0].backup.clone();
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), "old");

    let out = undo_with_fixture(&entry).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert_eq!(e.read("readme.txt"), "old");
    assert!(!backup.exists());
}

/// 파일 ↔ 기존 폴더 + Replace — 폴더째 백업, Ctrl+Z 가 폴더를 되돌린다 (§4 폴더 교체 규칙).
#[tokio::test]
async fn replace_file_over_existing_folder_backs_up_whole_folder_and_undo_restores() {
    let e = env().await;
    std::fs::create_dir(e.p("notes")).unwrap();
    std::fs::write(e.p("notes/keep.md"), "mine").unwrap();
    write_zip(&e.p("n.zip"), &[("notes", "a file now")]);

    let (entry, _, s) = e.here("n.zip", ExtractConflict::Replace).await.unwrap();
    assert_eq!(e.read("notes"), "a file now");
    let backup = s.replaced[0].backup.clone();
    assert_eq!(
        std::fs::read_to_string(backup.join("keep.md")).unwrap(),
        "mine"
    );

    let out = undo_with_fixture(&entry).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert!(e.p("notes").is_dir());
    assert_eq!(e.read("notes/keep.md"), "mine");
    assert!(!backup.exists());
}

/// Replace 라도 원본 아카이브는 옮기지 않는다 — 같은 이름 항목은 둘 다 유지로.
#[tokio::test]
async fn replace_never_moves_the_source_archive() {
    let e = env().await;
    write_zip(&e.p("inner.zip"), &[("x.txt", "x")]);
    let inner = std::fs::read(e.p("inner.zip")).unwrap();
    // outer.zip 안에 "outer.zip" 이라는 항목.
    {
        let f = std::fs::File::create(e.p("outer.zip")).unwrap();
        let mut w = zip::ZipWriter::new(f);
        w.start_file("outer.zip", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(&inner).unwrap();
        w.finish().unwrap();
    }
    let before = std::fs::read(e.p("outer.zip")).unwrap();
    let (_, _, s) = e.here("outer.zip", ExtractConflict::Replace).await.unwrap();
    assert_eq!(std::fs::read(e.p("outer.zip")).unwrap(), before);
    assert!(s.replaced.is_empty());
    assert_eq!(s.renamed[0].to, "outer (2).zip");
    assert_eq!(std::fs::read(e.p("outer (2).zip")).unwrap(), inner);
}

// ---------- 4. Skip ----------

#[tokio::test]
async fn skip_leaves_original_lists_item_and_trashes_staging() {
    let e = env().await;
    write_zip(&e.p("r.zip"), &[("readme.txt", "new"), ("other.txt", "o")]);
    std::fs::write(e.p("readme.txt"), "old").unwrap();

    let (entry, _, s) = e.here("r.zip", ExtractConflict::Skip).await.unwrap();
    assert_eq!(e.read("readme.txt"), "old");
    assert_eq!(e.read("other.txt"), "o");
    assert_eq!(s.skipped.len(), 1);
    assert_eq!(s.skipped[0].name, "readme.txt");
    assert_eq!(copied_of(&entry), vec![e.p("other.txt")]);
    let trashed = e.fs.trashed();
    assert_eq!(
        trashed.len(),
        1,
        "the staging folder (holding the skipped item)"
    );
    assert!(trashed[0]
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(STAGING_PREFIX));
    assert!(s.leftover_staging.is_none());
    e.assert_no_staging();
}

// ---------- 5. 링크는 병합하지 않는다 ----------

#[cfg(unix)]
#[tokio::test]
async fn symlink_named_like_staged_dir_is_a_conflict_not_a_merge() {
    let e = env().await;
    let outside = e.work.parent().unwrap().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, e.p("photos")).unwrap();
    write_zip(&e.p("p.zip"), &[("photos/", ""), ("photos/a.jpg", "A")]);

    let (_, _, s) = e.here("p.zip", ExtractConflict::KeepBoth).await.unwrap();
    assert_eq!(
        std::fs::read_dir(&outside).unwrap().count(),
        0,
        "nothing written through the link"
    );
    assert!(std::fs::symlink_metadata(e.p("photos"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(e.read("photos (2)/a.jpg"), "A");
    assert_eq!(s.renamed[0].to, "photos (2)");

    // Replace 는 링크 자신을 백업으로 옮긴다 (대상 폴더는 그대로).
    let (_, _, s) = e.here("p.zip", ExtractConflict::Replace).await.unwrap();
    assert!(
        e.p("photos").is_dir()
            && !std::fs::symlink_metadata(e.p("photos"))
                .unwrap()
                .file_type()
                .is_symlink()
    );
    assert_eq!(e.read("photos/a.jpg"), "A");
    assert!(std::fs::symlink_metadata(&s.replaced[0].backup)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
}

// ---------- 6. 포맷·암호 ----------

#[tokio::test]
async fn single_gz_lands_as_file_next_to_archive() {
    let e = env().await;
    {
        let f = std::fs::File::create(e.p("log.txt.gz")).unwrap();
        let mut gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        gz.write_all(b"line\n").unwrap();
        gz.finish().unwrap();
    }
    let (entry, _, _) = e
        .here("log.txt.gz", ExtractConflict::KeepBoth)
        .await
        .unwrap();
    assert_eq!(e.read("log.txt"), "line\n");
    assert_eq!(copied_of(&entry), vec![e.p("log.txt")]);
    e.assert_no_staging();
}

#[tokio::test]
async fn targz_with_nested_dirs_extracts_tree() {
    let e = env().await;
    write_targz(
        &e.p("t.tar.gz"),
        &[
            ("top/mid/leaf.txt", "leaf"),
            ("top/side.txt", "side"),
            ("root.txt", "r"),
        ],
    );
    let (entry, _, _) = e.here("t.tar.gz", ExtractConflict::KeepBoth).await.unwrap();
    assert_eq!(e.read("top/mid/leaf.txt"), "leaf");
    assert_eq!(e.read("top/side.txt"), "side");
    assert_eq!(e.read("root.txt"), "r");
    let mut copied = copied_of(&entry);
    copied.sort();
    assert_eq!(copied, vec![e.p("root.txt"), e.p("top")]);
    e.assert_no_staging();
}

#[tokio::test]
async fn password_zip_without_password_places_nothing_and_cleans_staging() {
    let e = env().await;
    {
        let f = std::fs::File::create(e.p("secret.zip")).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().with_aes_encryption(zip::AesMode::Aes256, "s3cret");
        w.start_file("msg.txt", opts).unwrap();
        w.write_all(b"top secret").unwrap();
        w.finish().unwrap();
    }
    let err = e
        .here("secret.zip", ExtractConflict::KeepBoth)
        .await
        .unwrap_err();
    assert!(matches!(err, DuetError::NeedPassword), "{err:?}");
    let names: Vec<String> = std::fs::read_dir(&e.work)
        .unwrap()
        .map(|x| x.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["secret.zip".to_string()]);
    assert!(
        e.ctx.journal.history(10).await.is_empty(),
        "no journal entry"
    );

    let (_, _, _) = e
        .here_pw("secret.zip", ExtractConflict::KeepBoth, Some("s3cret"))
        .await
        .unwrap();
    assert_eq!(e.read("msg.txt"), "top secret");
}

// ---------- 7. 배치 도중 실패 ----------

#[tokio::test]
async fn failure_mid_placement_journals_what_was_placed() {
    let mut e = env().await;
    write_zip(
        &e.p("m.zip"),
        &[("a.txt", "A"), ("b.txt", "B"), ("c.txt", "C")],
    );
    e.fs.fail_rename_to = Some("b.txt".into());

    let err = e
        .here("m.zip", ExtractConflict::KeepBoth)
        .await
        .unwrap_err();
    assert!(matches!(err, DuetError::Io(_)), "{err:?}");
    // a.txt 는 놓였고 journal 에 있다. b.txt 는 빈 자리만 남아 journal 에 실렸다(지우지 않음,
    // Ctrl+Z 가 휴지통으로). c.txt 는 안 놓였다.
    assert_eq!(e.read("a.txt"), "A");
    assert_eq!(std::fs::metadata(e.p("b.txt")).unwrap().len(), 0);
    assert!(!e.p("c.txt").exists());
    if let DuetError::Io(msg) = &err {
        assert!(msg.contains("placeholder"), "{msg}");
    }
    let hist = e.ctx.journal.history(10).await;
    assert_eq!(hist.len(), 1);
    assert_eq!(copied_of(&hist[0]), vec![e.p("a.txt"), e.p("b.txt")]);
    // 못 옮긴 b.txt·c.txt 는 준비 폴더째 (fixture) 휴지통으로.
    assert_eq!(e.fs.trashed().len(), 1);
    e.assert_no_staging();
}

/// 원격은 이번 범위에서 거부 — 아무것도 만들지 않는다.
#[tokio::test]
async fn remote_archive_is_refused_before_touching_anything() {
    let e = env().await;
    write_zip(&e.p("r.zip"), &[("x", "x")]);
    let archive = EntryRef {
        location: Location {
            source: SourceId::Ssh {
                connection_id: crate::types::ConnectionId("c1".into()),
                host_ip: std::net::IpAddr::from([127, 0, 0, 1]),
                user: "u".into(),
            },
            path: e.work.clone(),
        },
        name: "r.zip".into(),
    };
    let err = e
        .run(archive, ExtractConflict::KeepBoth, None, &[])
        .await
        .unwrap_err();
    assert!(matches!(err, DuetError::NotSupported(_)));
    assert_eq!(std::fs::read_dir(&e.work).unwrap().count(), 1);
}

// ---------- 리뷰 반영: 보호 목록·병합 undo·자리 재확인 ----------

/// 보호 목록은 같은 폴더·같은 source 에 지금 일반 파일로 있는 것만 받는다.
#[tokio::test]
async fn protected_sources_keeps_only_existing_files_in_the_same_folder() {
    let e = env().await;
    write_zip(&e.p("a.zip"), &[("x", "x")]);
    write_zip(&e.p("b.zip"), &[("y", "y")]);
    std::fs::create_dir(e.p("dir.zip")).unwrap();
    let other = e.work.parent().unwrap().join("elsewhere");
    std::fs::create_dir(&other).unwrap();
    std::fs::write(other.join("c.zip"), b"c").unwrap();
    let here = |dir: &Path, name: &str| EntryRef {
        location: Location {
            source: SourceId::Local,
            path: dir.to_path_buf(),
        },
        name: name.into(),
    };
    let batch = vec![
        here(&e.work, "a.zip"),
        here(&e.work, "b.zip"),
        here(&e.work, "missing.zip"),
        here(&e.work, "dir.zip"),
        here(&other, "c.zip"),
    ];
    let got = protected_sources(&e.fs, &here(&e.work, "a.zip"), &batch).await;
    assert_eq!(got, vec![e.p("a.zip"), e.p("b.zip")]);
}

/// 암호 재시도 + Replace 도 처음 일괄의 형제 원본 아카이브를 옮기지 않는다.
#[tokio::test]
async fn password_retry_with_replace_never_moves_sibling_source_archives() {
    let e = env().await;
    write_zip(&e.p("b.zip"), &[("inside-b.txt", "b")]);
    let sibling = std::fs::read(e.p("b.zip")).unwrap();
    {
        let f = std::fs::File::create(e.p("a.zip")).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().with_aes_encryption(zip::AesMode::Aes256, "pw");
        w.start_file("b.zip", opts).unwrap();
        w.write_all(b"not the sibling").unwrap();
        w.finish().unwrap();
    }
    let a = EntryRef {
        location: Location {
            source: SourceId::Local,
            path: e.work.clone(),
        },
        name: "a.zip".into(),
    };
    let b = EntryRef {
        name: "b.zip".into(),
        ..a.clone()
    };
    let batch = vec![a.clone(), b];
    // 1차: 암호 없음 → NeedPassword. 재시도는 같은 일괄 목록으로 보호 경로를 다시 만든다.
    let protect = protected_sources(&e.fs, &a, &batch).await;
    let first = e
        .run(a.clone(), ExtractConflict::Replace, None, &protect)
        .await;
    assert!(matches!(first, Err(DuetError::NeedPassword)));
    let protect = protected_sources(&e.fs, &a, &batch).await;
    let (_, _, s) = e
        .run(a, ExtractConflict::Replace, Some("pw".into()), &protect)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(e.p("b.zip")).unwrap(),
        sibling,
        "sibling untouched"
    );
    assert!(s.replaced.is_empty());
    assert_eq!(e.read("b (2).zip"), "not the sibling");
}

/// 두 아카이브가 **이미 있는 사용자 폴더**로 병합 — 각자의 undo 는 자기 파일만 치우고
/// 사용자의 원래 파일은 그대로.
#[tokio::test]
async fn undo_of_each_merge_into_existing_user_folder_removes_only_its_files() {
    let e = env().await;
    std::fs::create_dir(e.p("photos")).unwrap();
    std::fs::write(e.p("photos/mine.jpg"), "user").unwrap();
    write_zip(&e.p("one.zip"), &[("photos/", ""), ("photos/a.jpg", "A")]);
    write_zip(&e.p("two.zip"), &[("photos/", ""), ("photos/b.jpg", "B")]);

    let (first, _, _) = e.here("one.zip", ExtractConflict::KeepBoth).await.unwrap();
    let (second, _, _) = e.here("two.zip", ExtractConflict::KeepBoth).await.unwrap();
    assert_eq!(copied_of(&first), vec![e.p("photos/a.jpg")]);
    assert_eq!(copied_of(&second), vec![e.p("photos/b.jpg")]);

    let out = undo_with_fixture(&second).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert!(!e.p("photos/b.jpg").exists());
    assert_eq!(e.read("photos/a.jpg"), "A");
    assert_eq!(e.read("photos/mine.jpg"), "user");

    let out = undo_with_fixture(&first).await;
    assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
    assert!(!e.p("photos/a.jpg").exists());
    assert_eq!(e.read("photos/mine.jpg"), "user");
    assert!(e.p("photos").is_dir(), "the user's folder stays");
}

/// 예약 뒤 다른 프로그램이 그 자리에 쓰면 덮지 않고 건너뛴다(최선 노력 재확인).
#[tokio::test]
async fn placeholder_written_by_someone_else_is_not_overwritten() {
    let mut e = env().await;
    write_zip(&e.p("r.zip"), &[("note.txt", "ours"), ("other.txt", "o")]);
    e.fs.scribble_after_reserve = Some("note.txt".into());
    let (entry, _, s) = e.here("r.zip", ExtractConflict::KeepBoth).await.unwrap();
    assert_eq!(e.read("note.txt"), "written by another program");
    assert_eq!(s.skipped.len(), 1);
    assert_eq!(s.skipped[0].name, "note.txt");
    assert_eq!(copied_of(&entry), vec![e.p("other.txt")]);
}

// ---------- 리뷰 반영 2: journal 실패 되돌림 · 남은 준비 폴더 보고 ----------

/// journal 기록이 실패하면 놓은 것을 그 자리에서 되돌린다 — 교체한 원본은 제자리로,
/// 새 항목은 (fixture) 휴지통으로. 에러 종류는 journal 오류 그대로.
#[tokio::test]
async fn journal_failure_rolls_the_extraction_back() {
    let e = env().await;
    write_zip(&e.p("r.zip"), &[("readme.txt", "new"), ("other.txt", "o")]);
    std::fs::write(e.p("readme.txt"), "old").unwrap();
    e.break_journal();

    let out = e
        .outcome(
            EntryRef {
                location: Location {
                    source: SourceId::Local,
                    path: e.work.clone(),
                },
                name: "r.zip".into(),
            },
            ExtractConflict::Replace,
            None,
            &[],
        )
        .await;
    let err = out.result.unwrap_err();
    let DuetError::Io(msg) = &err else {
        panic!("journal error kind must be kept: {err:?}")
    };
    assert!(msg.contains("rolled back"), "{msg}");
    assert_eq!(e.read("readme.txt"), "old", "original restored");
    assert_eq!(e.work_names(), vec!["r.zip", "readme.txt"]);
    // 만든 것 두 개(readme.txt 새것, other.txt)가 휴지통으로.
    assert_eq!(e.fs.trashed().len(), 2);
}

/// 되돌림도 실패하면(휴지통 거부) 원본이 남은 백업 경로와 남은 생성물을 메시지에 적는다.
#[tokio::test]
async fn failed_rollback_names_backups_and_items_left_in_place() {
    let mut e = env().await;
    write_zip(&e.p("r.zip"), &[("readme.txt", "new"), ("other.txt", "o")]);
    std::fs::write(e.p("readme.txt"), "old").unwrap();
    let mut refusing = e.fs.clone();
    refusing.fail_trash = true;
    e.undo_fs = Some(refusing);
    e.break_journal();

    let err = e.here("r.zip", ExtractConflict::Replace).await.unwrap_err();
    let DuetError::Io(msg) = &err else {
        panic!("{err:?}")
    };
    let backup = e
        .work_names()
        .into_iter()
        .find(|n| n.starts_with("readme.txt.bak."))
        .expect("original kept in a backup");
    assert!(msg.contains(&backup), "{msg}");
    assert!(msg.contains("other.txt"), "{msg}");
    assert!(msg.contains("partly"), "{msg}");
    assert_eq!(std::fs::read_to_string(e.p(&backup)).unwrap(), "old");
}

/// 준비 폴더를 휴지통으로 못 보내면 — 실패한 실행에서도 — 그 경로가 요약에 실린다.
#[tokio::test]
async fn leftover_staging_is_reported_in_the_summary_even_on_error() {
    let mut e = env().await;
    write_zip(&e.p("m.zip"), &[("a.txt", "A"), ("b.txt", "B")]);
    e.fs.fail_rename_to = Some("a.txt".into());
    e.fs.fail_trash = true;

    let out = e
        .outcome(
            EntryRef {
                location: Location {
                    source: SourceId::Local,
                    path: e.work.clone(),
                },
                name: "m.zip".into(),
            },
            ExtractConflict::KeepBoth,
            None,
            &[],
        )
        .await;
    assert!(out.result.is_err());
    assert!(out.summary.is_notable());
    let left = out
        .summary
        .leftover_staging
        .as_ref()
        .expect("leftover reported");
    assert!(left
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(STAGING_PREFIX));
    assert!(left.is_dir(), "left in place, not deleted");
}
