//! SC-17: 비교가 NFC 키로 짝지은 행을 **정규화를 구분하는 FS**(Linux ext4 원격·NTFS)에
//! 적용·병합할 때 각 쪽 실제 이름으로 가는지. macOS(APFS, 정규화 무시)에서도 돌도록
//! 이름을 바이트 그대로만 찾는 래퍼 FS 로 그 FS 를 흉내 낸다. 모든 경로는 TempDir 안.
use async_trait::async_trait;
use duet_lib::core::compare::{compare_dirs, CompareStatus};
use duet_lib::core::ops::{
    apply_compare, apply_three_way, detect_renames, merge_bidir, verify_compare, ApplyDecision,
    ApplyDirection, OpCtx,
};
use duet_lib::core::three_way::compare_three_way;
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

/// R2-1: 3-way 도 NFC 규칙으로 판정한다 — 빈 base 에 왼쪽 NFC·오른쪽 NFD 같은 이름이 각자
/// 추가되면 "양쪽 추가" 충돌이지, 서로 다른 두 추가(자동 적용)가 아니다. 적용은 충돌을
/// 건너뛰므로 왼쪽 원본이 몰래 덮이지 않는다.
#[tokio::test]
async fn sc17_three_way_treats_nfc_nfd_additions_as_one_conflict() {
    let t = tempdir().unwrap();
    let (b, l, r) = (t.path().join("B"), t.path().join("L"), t.path().join("R"));
    for d in [&b, &l, &r] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(l.join(nfc("보고서.txt")), b"LEFT").unwrap();
    std::fs::write(r.join(nfd("보고서.txt")), b"RIGHT").unwrap();
    let right_fs = SensitiveFs { root: r.clone() };
    let plan = compare_three_way(&LocalFs, loc(&b), &LocalFs, loc(&l), &right_fs, loc(&r))
        .await
        .unwrap();
    assert_eq!((plan.conflicts, plan.auto), (1, 0), "{:?}", plan.entries);
    apply_three_way(
        &LocalFs,
        loc(&b),
        &LocalFs,
        loc(&l),
        &right_fs,
        loc(&r),
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(l.join(nfc("보고서.txt"))).unwrap(), b"LEFT");
    assert_eq!(std::fs::read(r.join(nfd("보고서.txt"))).unwrap(), b"RIGHT");
}

/// R2-3: 내용 검증도 짝지은 행을 각 쪽 실제 이름으로 읽는다.
#[tokio::test]
async fn sc17_verify_reads_each_side_real_name() {
    let t = tempdir().unwrap();
    let (l, r) = (t.path().join("L"), t.path().join("R"));
    std::fs::create_dir_all(&l).unwrap();
    std::fs::create_dir_all(&r).unwrap();
    std::fs::write(l.join(nfc("보고서.txt")), b"same").unwrap();
    std::fs::write(r.join(nfd("보고서.txt")), b"same").unwrap();
    let right_fs = SensitiveFs { root: r.clone() };
    let plan = compare_dirs(&LocalFs, loc(&l), &right_fs, loc(&r))
        .await
        .unwrap();
    let rels: Vec<String> = plan.entries.iter().map(|e| e.rel.clone()).collect();
    assert_eq!(rels.len(), 1);
    let out = verify_compare(&LocalFs, &loc(&l), &right_fs, &loc(&r), rels, None)
        .await
        .unwrap();
    assert_eq!(out[0].equal, Some(true));
}

/// R2-3: 짝지은 폴더(왼쪽 NFC, 오른쪽 NFD) 안의 이름 바꾸기도 감지한다 — 오른쪽 후보를
/// 없는 NFC 부모 경로로 읽지 않는다.
#[tokio::test]
async fn sc17_detect_rename_under_paired_dir() {
    let t = tempdir().unwrap();
    let (l, r) = (t.path().join("L"), t.path().join("R"));
    std::fs::create_dir_all(l.join(nfc("자료"))).unwrap();
    std::fs::create_dir_all(r.join(nfd("자료"))).unwrap();
    std::fs::write(l.join(nfc("자료")).join("old.txt"), b"moved body").unwrap();
    std::fs::write(r.join(nfd("자료")).join("new.txt"), b"moved body").unwrap();
    let right_fs = SensitiveFs { root: r.clone() };
    let mut plan = compare_dirs(&LocalFs, loc(&l), &right_fs, loc(&r))
        .await
        .unwrap();
    detect_renames(&mut plan, &LocalFs, &right_fs, None)
        .await
        .unwrap();
    assert_eq!(plan.moves.len(), 1, "{:?}", plan.entries);
}

/// R3 리뷰(sol-4) 재현 — 한 폴더에 정규화만 다른 두 이름이 함께 있는(정규화 구분 FS) 3-way.
/// ASCII 백킹 이름으로 APFS 위에서 NFC·NFD 를 서로 다른 파일로 흉내 내고, 모의 SSH 소스로
/// relay 경로를 탄다(실제 연결 없음). 앞 두 개는 통과(삭제 전파), 뒤 두 개는 남은 결함 R3-S4-1.
mod r3_ambiguous_three_way {
    use super::*;
    use duet_lib::core::three_way::ThreeWayStatus;

    struct EncodedFs {
        root: PathBuf,
    }
    impl EncodedFs {
        fn disk(&self, p: &Path) -> PathBuf {
            let rel = p.strip_prefix(&self.root).expect("fixture boundary");
            rel.components().fold(self.root.clone(), |out, c| {
                let name = c.as_os_str().to_string_lossy();
                out.join(name.replace('é', "__C__").replace("e\u{301}", "__D__"))
            })
        }
        fn seed(&self, name: &str, body: &[u8]) {
            let p = self.disk(&self.root.join(name));
            std::fs::write(&p, body).unwrap();
            let fixed =
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
            std::fs::OpenOptions::new()
                .append(true)
                .open(p)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(fixed))
                .unwrap();
        }
        fn contents(&self) -> Vec<(String, Vec<u8>)> {
            let mut out: Vec<_> = std::fs::read_dir(&self.root)
                .unwrap()
                .map(|e| {
                    let e = e.unwrap();
                    let name = e.file_name().to_string_lossy().into_owned();
                    (
                        name.replace("__C__", "é").replace("__D__", "e\u{301}"),
                        std::fs::read(e.path()).unwrap(),
                    )
                })
                .collect();
            out.sort();
            out
        }
    }

    #[async_trait]
    impl FileSystem for EncodedFs {
        fn source_id(&self) -> SourceId {
            SourceId::Ssh {
                connection_id: duet_lib::types::ConnectionId(
                    self.root
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                ),
                host_ip: std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
                user: "fixture".into(),
            }
        }
        async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
            let mut entries = LocalFs.list(&self.disk(p)).await?;
            for e in &mut entries {
                e.name = e.name.replace("__C__", "é").replace("__D__", "e\u{301}");
            }
            Ok(entries)
        }
        async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
            LocalFs.metadata(&self.disk(p)).await
        }
        async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
            LocalFs.rename(&self.disk(f), &self.disk(t)).await
        }
        async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
            LocalFs.mkdir(&self.disk(p)).await
        }
        async fn create_new_file(&self, p: &Path) -> Result<(), DuetError> {
            LocalFs.create_new_file(&self.disk(p)).await
        }
        async fn remove_empty_dir(&self, p: &Path) -> Result<(), DuetError> {
            LocalFs.remove_empty_dir(&self.disk(p)).await
        }
        async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
            let dir = self.root.parent().unwrap().join(format!(
                "Recovered-{}",
                self.root.file_name().unwrap().to_string_lossy()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let target = dir.join(self.disk(p).file_name().unwrap());
            LocalFs.rename(&self.disk(p), &target).await?;
            Ok(TrashLocation::Local {
                trash_id: target.to_string_lossy().into_owned(),
            })
        }
        async fn remove(&self, _: &Path) -> Result<(), DuetError> {
            panic!("permanent removal forbidden in fixture")
        }
        async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
            panic!("restore not used in fixture")
        }
        async fn read_full(&self, p: &Path) -> Result<Vec<u8>, DuetError> {
            LocalFs.read_full(&self.disk(p)).await
        }
        async fn write_full(&self, p: &Path, b: &[u8]) -> Result<(), DuetError> {
            LocalFs.write_full(&self.disk(p), b).await
        }
        async fn open_read(
            &self,
            p: &Path,
            o: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            LocalFs.open_read(&self.disk(p), o).await
        }
        async fn open_write(
            &self,
            p: &Path,
            o: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            LocalFs.open_write(&self.disk(p), o).await
        }
    }

    fn sides(t: &Path) -> [EncodedFs; 3] {
        ["B", "L", "R"].map(|s| {
            let root = t.join(s);
            std::fs::create_dir_all(&root).unwrap();
            EncodedFs { root }
        })
    }
    fn location(f: &EncodedFs) -> Location {
        Location {
            source: f.source_id(),
            path: f.root.clone(),
        }
    }
    async fn plan(
        b: &EncodedFs,
        l: &EncodedFs,
        r: &EncodedFs,
    ) -> duet_lib::core::three_way::ThreeWayPlan {
        compare_three_way(b, location(b), l, location(l), r, location(r))
            .await
            .unwrap()
    }
    async fn apply(b: &EncodedFs, l: &EncodedFs, r: &EncodedFs, t: &Path) {
        apply_three_way(
            b,
            location(b),
            l,
            location(l),
            r,
            location(r),
            &ctx(t).await,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn base_nfd_left_deleted_right_nfc_propagates_real_name() {
        let t = tempdir().unwrap();
        let [b, l, r] = sides(t.path());
        b.seed("e\u{301}.txt", b"same");
        r.seed("é.txt", b"same");
        let p = plan(&b, &l, &r).await;
        assert_eq!(p.entries.len(), 1);
        assert_eq!(p.entries[0].status, ThreeWayStatus::LeftDeleted);
        apply(&b, &l, &r, t.path()).await;
        assert!(r.contents().is_empty());
        assert_eq!(b.contents()[0].1, b"same");
    }

    #[tokio::test]
    async fn ambiguous_base_keeps_two_exact_deletions() {
        let t = tempdir().unwrap();
        let [b, l, r] = sides(t.path());
        b.seed("é.txt", b"C");
        b.seed("e\u{301}.txt", b"DD");
        l.seed("é.txt", b"C");
        r.seed("e\u{301}.txt", b"DD");
        let p = plan(&b, &l, &r).await;
        assert_eq!((p.auto, p.conflicts), (2, 0));
        apply(&b, &l, &r, t.path()).await;
        assert!(l.contents().is_empty());
        assert!(r.contents().is_empty());
    }

    #[tokio::test]
    #[ignore = "R3-S4-1 repro: ambiguous-key addition overwrites the other normalization form"]
    async fn ambiguous_left_addition_must_preserve_right_exact_partner() {
        let t = tempdir().unwrap();
        let [b, l, r] = sides(t.path());
        l.seed("é.txt", b"NEW-NFC");
        l.seed("e\u{301}.txt", b"KEEP-NFD");
        r.seed("e\u{301}.txt", b"KEEP-NFD");
        let p = plan(&b, &l, &r).await;
        assert_eq!((p.auto, p.conflicts), (1, 0));
        assert_eq!(p.entries[0].status, ThreeWayStatus::LeftAdded);
        apply(&b, &l, &r, t.path()).await;
        assert_eq!(r.contents(), l.contents());
    }

    #[tokio::test]
    #[ignore = "R3-S4-1 repro: ambiguous-key addition overwrites the other normalization form"]
    async fn ambiguous_right_addition_must_preserve_left_exact_partner() {
        let t = tempdir().unwrap();
        let [b, l, r] = sides(t.path());
        r.seed("é.txt", b"NEW-NFC");
        r.seed("e\u{301}.txt", b"KEEP-NFD");
        l.seed("e\u{301}.txt", b"KEEP-NFD");
        let p = plan(&b, &l, &r).await;
        assert_eq!((p.auto, p.conflicts), (1, 0));
        assert_eq!(p.entries[0].status, ThreeWayStatus::RightAdded);
        apply(&b, &l, &r, t.path()).await;
        assert_eq!(l.contents(), r.contents());
    }
}
