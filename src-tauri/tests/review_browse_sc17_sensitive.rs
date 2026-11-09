//! SC-17: 비교가 NFC 키로 짝지은 행을 **정규화를 구분하는 FS**(Linux ext4 원격·NTFS)에
//! 적용·병합할 때 각 쪽 실제 이름으로 가는지. macOS(APFS, 정규화 무시)에서도 돌도록
//! 이름을 바이트 그대로만 찾는 래퍼 FS 로 그 FS 를 흉내 낸다. 모든 경로는 TempDir 안.
use async_trait::async_trait;
use duet_lib::core::compare::{compare_dirs, CompareStatus};
use duet_lib::core::ops::{apply_compare, merge_bidir, ApplyDecision, ApplyDirection, OpCtx};
use duet_lib::fs::{FileSystem, LocalFs};
use duet_lib::services::journal::Journal;
use duet_lib::services::settings::SettingsStore;
use duet_lib::types::{DuetError, Entry, EntryMeta, Location, SourceId, TrashLocation};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

fn nfc(s: &str) -> String {
    s.nfc().collect()
}
fn nfd(s: &str) -> String {
    s.nfd().collect()
}
fn loc(path: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: path.into(),
    }
}
async fn ctx(root: &Path) -> OpCtx {
    OpCtx {
        journal: Journal::load_from(&root.join("j.jsonl")).await.unwrap(),
        settings: SettingsStore::load_from(&root.join("s.toml"))
            .await
            .unwrap(),
        pool: None,
        app: None,
    }
}

/// 이름을 바이트 그대로만 찾는 FS — `root` 아래 각 조각이 부모 목록에 정확히 있어야 한다.
/// 쓰기 대상의 마지막 조각이 없는데 정규화만 같은 이름이 있으면, 진짜 정규화 구분 FS 라면
/// "옆에 새 파일"이 생길 상황이라 오류로 알린다(APFS 위에서는 그렇게 만들 수 없으므로).
struct SensitiveFs {
    root: PathBuf,
}

impl SensitiveFs {
    fn names(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }
    /// `p` 의 조각을 검사한다. `writing` 이면 마지막 조각은 없어도 되지만 정규화 쌍이 있으면 오류.
    fn check(&self, p: &Path, writing: bool) -> Result<(), DuetError> {
        let rel = p
            .strip_prefix(&self.root)
            .map_err(|_| DuetError::Io(format!("outside fixture: {}", p.display())))?;
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let mut cur = self.root.clone();
        for (i, part) in parts.iter().enumerate() {
            let names = Self::names(&cur);
            let last = i + 1 == parts.len();
            if !names.iter().any(|n| n == part) {
                if writing && last {
                    if names.iter().any(|n| nfc(n) == nfc(part)) {
                        return Err(DuetError::Io(format!(
                            "would create a normalization twin: {}",
                            p.display()
                        )));
                    }
                    return Ok(());
                }
                return Err(DuetError::NotFound(p.display().to_string()));
            }
            cur = cur.join(part);
        }
        Ok(())
    }
}

#[async_trait]
impl FileSystem for SensitiveFs {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }
    async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
        self.check(p, false)?;
        LocalFs.list(p).await
    }
    async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        self.check(p, false)?;
        LocalFs.metadata(p).await
    }
    async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
        self.check(f, false)?;
        self.check(t, true)?;
        LocalFs.rename(f, t).await
    }
    async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
        self.check(p, true)?;
        LocalFs.mkdir(p).await
    }
    async fn create_new_file(&self, p: &Path) -> Result<(), DuetError> {
        self.check(p, true)?;
        LocalFs.create_new_file(p).await
    }
    async fn remove_empty_dir(&self, p: &Path) -> Result<(), DuetError> {
        self.check(p, false)?;
        LocalFs.remove_empty_dir(p).await
    }
    async fn trash(&self, _: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        panic!("OS trash forbidden in fixture")
    }
    async fn remove(&self, _: &Path) -> Result<(), DuetError> {
        panic!("permanent removal forbidden in fixture")
    }
    async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
        panic!("OS trash forbidden in fixture")
    }
    async fn read_full(&self, p: &Path) -> Result<Vec<u8>, DuetError> {
        self.check(p, false)?;
        LocalFs.read_full(p).await
    }
    async fn write_full(&self, p: &Path, b: &[u8]) -> Result<(), DuetError> {
        self.check(p, true)?;
        LocalFs.write_full(p, b).await
    }
    async fn open_read(
        &self,
        p: &Path,
        o: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        self.check(p, false)?;
        LocalFs.open_read(p, o).await
    }
    async fn open_write(
        &self,
        p: &Path,
        o: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        self.check(p, true)?;
        LocalFs.open_write(p, o).await
    }
}

/// 왼쪽(로컬) NFC 이름, 오른쪽(정규화 구분 FS) NFD 이름 — 비교는 한 행, 적용은 양방향 모두
/// 오른쪽의 실제 NFD 파일을 읽고 쓴다(없는 NFC 이름으로 가지 않는다).
#[tokio::test]
async fn sc17_apply_uses_each_side_real_name_on_sensitive_fs() {
    for direction in [ApplyDirection::ToLeft, ApplyDirection::ToRight] {
        let t = tempdir().unwrap();
        let (l, r) = (t.path().join("L"), t.path().join("R"));
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        let (fc, fd) = (nfc("보고서.txt"), nfd("보고서.txt"));
        std::fs::write(l.join(&fc), b"LEFT").unwrap();
        std::fs::write(r.join(&fd), b"RIGHT-longer").unwrap();
        let right_fs = SensitiveFs { root: r.clone() };

        let plan = compare_dirs(&LocalFs, loc(&l), &right_fs, loc(&r))
            .await
            .unwrap();
        assert_eq!(plan.entries.len(), 1, "{:?}", plan.entries);
        assert!(!matches!(
            plan.entries[0].status,
            CompareStatus::LeftOnly | CompareStatus::RightOnly
        ));
        let to_left = matches!(direction, ApplyDirection::ToLeft);
        apply_compare(
            &LocalFs,
            loc(&l),
            &right_fs,
            loc(&r),
            vec![ApplyDecision {
                rel: plan.entries[0].rel.clone(),
                direction,
            }],
            &ctx(t.path()).await,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("apply to_left={to_left}: {e:?}"));
        let want: &[u8] = if to_left { b"RIGHT-longer" } else { b"LEFT" };
        assert_eq!(std::fs::read(l.join(&fc)).unwrap(), want);
        assert_eq!(std::fs::read(r.join(&fd)).unwrap(), want);
    }
}

/// 짝지은 폴더(왼쪽 NFC, 오른쪽 NFD) 안의 왼쪽 전용 파일은 병합 시 오른쪽 **NFD 폴더** 안에
/// 만들어진다 — NFC 이름의 새 폴더(정규화 쌍)를 만들지 않는다.
#[tokio::test]
async fn sc17_merge_into_paired_dir_uses_real_dir_name_on_sensitive_fs() {
    let t = tempdir().unwrap();
    let (l, r) = (t.path().join("L"), t.path().join("R"));
    let (dc, dd) = (nfc("자료"), nfd("자료"));
    std::fs::create_dir_all(l.join(&dc)).unwrap();
    std::fs::create_dir_all(r.join(&dd)).unwrap();
    std::fs::write(l.join(&dc).join("new.txt"), b"fresh").unwrap();
    let right_fs = SensitiveFs { root: r.clone() };

    merge_bidir(
        &LocalFs,
        loc(&l),
        &right_fs,
        loc(&r),
        false,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(r.join(&dd).join("new.txt")).unwrap(),
        b"fresh"
    );
    assert_eq!(SensitiveFs::names(&r), vec![dd]);
}
