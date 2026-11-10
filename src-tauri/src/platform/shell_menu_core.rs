//! 셸 컨텍스트 메뉴의 OS 독립 부분 — 선택 검증·캐시 키와 token↔세션 장부.
//!
//! COM 호출은 `shell_menu.rs`(Windows 전용)에 있고, 여기는 순수 로직만 둔다. 그래야 macOS/Linux
//! 에서도 단위 테스트로 규칙을 고정할 수 있다.
//! - [`shell_selection`]: 다중 선택을 Explorer 처럼 "한 폴더 안의 항목들" 로만 받는다.
//!   [`shell_target`] 은 여기에 scope 규칙을 더한다(빈 영역 메뉴는 폴더 하나).
//! - [`SessionCache`]: 빌드한 메뉴 세션을 키별로 보관하고 token 으로 찾는다. token 은 빌드마다
//!   새로 발급되므로, 지난 선택의 token 이 새로 빌드된 다른 메뉴로 풀리는 일이 없다.
//! - [`stale_menu_error`] / [`invoke_error`]: 셸 명령 실행 실패를 프론트가 구분할 수 있는
//!   `DuetError` 로 바꾼다(만료=NotFound, 사용자 취소=Cancelled, 그 외=Io).

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::path::{Component, Path, PathBuf};

use super::ShellScope;
use crate::types::DuetError;

/// 셸 메뉴 대상 선택을 검증하고 캐시 키로 쓸 경로 목록을 돌려준다.
///
/// - 각 경로를 [`super::local_abs`] 로 절대경로화한다(드라이브 없는 경로 보정).
/// - 비어 있으면 거부.
/// - `.`·`..` 경로 조각이 있으면 거부. `sub/..` 는 글자상 부모가 `sub` 이지만 실제 항목은 `sub`
///   의 부모 폴더라, 부모 비교를 통과해도 셸이 엉뚱한 부모에 묶는다. 프론트는 이런 경로를 만들지
///   않으므로 정규화하지 않고 거부한다.
/// - 모든 항목의 부모(`Path::parent`, 문자열이 아닌 경로 컴포넌트 비교)가 같아야 한다 — 셸은 한
///   부모 폴더의 `GetUIObjectOf` 에 자식들을 한꺼번에 넘기므로, 다른 폴더의 항목은 같이 못 묶는다.
///   드라이브 루트처럼 부모가 없는 경로끼리는 "부모 없음" 으로 같다고 본다.
/// - 순서는 그대로 둔다(화면 표시 순서 = 셸에 넘기는 순서 = 캐시 키).
///
/// **`fs::canonicalize` 는 쓰지 않는다.** Windows 에선 `\\?\` 접두가 붙은 경로가 나와
/// `SHParseDisplayName` 입력으로 맞지 않고, 심볼릭 링크·정션을 대상 경로로 바꿔 사용자가 고른
/// 셸 항목(링크 자체)이 아닌 다른 항목의 메뉴가 된다. 그래서 별칭(대소문자·8.3 이름·링크)으로
/// 같은 폴더를 다르게 쓴 선택은 거부될 수 있다 — 프론트는 한 패널의 같은 경로 문자열로 만든다.
pub fn shell_selection(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, DuetError> {
    let paths: Vec<PathBuf> = paths.into_iter().map(super::local_abs).collect();
    if let Some(bad) = paths.iter().find(|p| has_dot_segment(p)) {
        return Err(DuetError::NotSupported(format!(
            "shell menu: path has . or .. segment ({})",
            bad.display()
        )));
    }
    let first = paths
        .first()
        .ok_or_else(|| DuetError::NotSupported("shell menu: empty selection".into()))?;
    let parent = first.parent();
    if let Some(other) = paths.iter().find(|p| p.parent() != parent) {
        return Err(DuetError::NotSupported(format!(
            "shell menu: selection spans folders ({} vs {})",
            first.display(),
            other.display()
        )));
    }
    Ok(paths)
}

/// 경로에 `.`·`..` 조각이 있는가. `Path::components` 는 중간·끝의 `.` 을 지워서 보여 주므로
/// 원문 조각도 본다(구분자 `/`·`\\` 둘 다 — 이 검사는 Windows 경로가 대상이다).
fn has_dot_segment(p: &Path) -> bool {
    p.components()
        .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
        || p.as_os_str()
            .to_string_lossy()
            .split(['/', '\\'])
            .any(|s| s == "." || s == "..")
}

/// scope 까지 본 셸 메뉴 대상 검증 — 명령 레이어의 진입점.
///
/// [`shell_selection`] 규칙에 더해, `Background`(폴더 빈 영역 메뉴)는 **그 폴더 하나**만 받는다
/// — 빈 영역 메뉴는 항목들이 아니라 현재 폴더 자체의 메뉴(`CreateViewObject`)라서다.
pub fn shell_target(paths: Vec<PathBuf>, scope: ShellScope) -> Result<Vec<PathBuf>, DuetError> {
    let paths = shell_selection(paths)?;
    if scope == ShellScope::Background && paths.len() != 1 {
        return Err(DuetError::NotSupported(format!(
            "shell menu: background menu takes one folder, got {}",
            paths.len()
        )));
    }
    Ok(paths)
}

/// 빌드한 메뉴 세션 장부 — 키(선택+scope)별 값 하나, token 역인덱스, 삽입 순서(오래된 것부터).
///
/// 값 `V` 는 Windows 에서 COM 객체를 쥔 세션(Drop 이 정리)이고, 테스트에선 아무 값이나 쓴다.
/// 이 타입은 정리 작업을 하지 않는다 — 꺼낸 값을 호출자가 버리면 그 Drop 이 정리한다.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct SessionCache<K, V> {
    entries: HashMap<K, (u64, V)>,
    by_token: HashMap<u64, K>,
    order: VecDeque<K>,
    next_token: u64,
    cap: usize,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl<K: Clone + Eq + Hash, V> SessionCache<K, V> {
    /// 빈 장부. `cap` 개를 넘으면 오래된 것부터 내보낸다. token 0 은 "세션 없음" 이라 1 부터.
    pub fn new(cap: usize) -> Self {
        Self {
            entries: HashMap::new(),
            by_token: HashMap::new(),
            order: VecDeque::new(),
            next_token: 1,
            cap,
        }
    }

    /// 새 token 발급 — 빌드마다 하나. 앱 수명 안에서 다시 나오지 않는다(u64 증가, 0 건너뜀).
    pub fn issue_token(&mut self) -> u64 {
        let t = self.next_token;
        self.next_token = self.next_token.wrapping_add(1).max(1);
        t
    }

    /// 키의 세션 (token, 값).
    pub fn get(&self, key: &K) -> Option<(u64, &V)> {
        self.entries.get(key).map(|(t, v)| (*t, v))
    }

    /// token 이 가리키는 **지금 살아 있는** 세션 (키, 값). 파기·교체된 세션의 token 은 None —
    /// 같은 키가 새로 빌드돼 있어도 그 세션의 token 이 다르면 풀어주지 않는다.
    pub fn resolve(&self, token: u64) -> Option<(&K, &V)> {
        let key = self.by_token.get(&token)?;
        match self.entries.get(key) {
            Some((t, v)) if *t == token => Some((key, v)),
            _ => None,
        }
    }

    /// 세션 보관. 같은 키의 기존 세션과 용량 초과로 밀려난 세션들을 (키, 값) 으로 돌려준다
    /// (호출자가 버려서 정리 + 다른 사본 갱신).
    pub fn insert(&mut self, key: K, token: u64, value: V) -> Vec<(K, V)> {
        let mut out: Vec<(K, V)> = self
            .remove(&key)
            .map(|v| (key.clone(), v))
            .into_iter()
            .collect();
        self.entries.insert(key.clone(), (token, value));
        self.by_token.insert(token, key.clone());
        self.order.push_back(key);
        while self.order.len() > self.cap {
            let Some(old) = self.order.front().cloned() else {
                break;
            };
            if let Some(v) = self.remove(&old) {
                out.push((old, v));
            } else {
                self.order.pop_front();
            }
        }
        out
    }

    /// 키의 세션을 꺼낸다 — token 역인덱스와 순서 목록에서도 지운다.
    pub fn remove(&mut self, key: &K) -> Option<V> {
        let (token, v) = self.entries.remove(key)?;
        self.by_token.remove(&token);
        self.order.retain(|k| k != key);
        Some(v)
    }

    /// 보관 중인 세션 수 (테스트 확인용).
    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// `HRESULT_FROM_WIN32(ERROR_CANCELLED)` — 셸 명령이 띄운 대화상자(UAC 등)를 사용자가 취소.
const HRESULT_CANCELLED: i32 = 0x8007_04C7_u32 as i32;
/// `E_ABORT` — 일부 셸 확장이 사용자 취소를 이 값으로 돌려준다.
const HRESULT_ABORT: i32 = 0x8000_4004_u32 as i32;

/// 실행하려던 메뉴 세션이 이미 없음(다시 빌드됨·밀려남·빌드 실패). 아무것도 실행하지 않았다.
/// 프론트는 `NotFound` 를 "메뉴를 다시 열어 주세요" 로 안내한다(셸 실행 경로에서 NotFound 는
/// 이것 하나뿐).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn stale_menu_error() -> DuetError {
    DuetError::NotFound("shell menu expired; open it again".into())
}

/// `InvokeCommand` 실패 HRESULT → `DuetError`. 사용자 취소는 `Cancelled`(프론트는 조용히),
/// 그 외는 원문과 HRESULT 를 담은 `Io`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn invoke_error(hresult: i32, message: &str) -> DuetError {
    if hresult == HRESULT_CANCELLED || hresult == HRESULT_ABORT {
        return DuetError::Cancelled;
    }
    let message = message.trim();
    DuetError::Io(format!(
        "shell command failed: {message} (0x{:08X})",
        hresult as u32
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn same_parent_selection_is_kept_in_order() {
        let sel = vec![p("/w/c.zip"), p("/w/a.zip"), p("/w/b.zip")];
        assert_eq!(shell_selection(sel.clone()).unwrap(), sel);
    }

    #[test]
    fn single_item_selection_is_ok() {
        assert_eq!(
            shell_selection(vec![p("/w/a.zip")]).unwrap(),
            vec![p("/w/a.zip")]
        );
    }

    #[test]
    fn mixed_files_and_dirs_in_one_folder_are_ok() {
        // 종류는 보지 않는다 — 같은 폴더면 파일+폴더 혼합도 Explorer 처럼 한 메뉴.
        let sel = vec![p("/w/dir"), p("/w/file.txt")];
        assert_eq!(shell_selection(sel.clone()).unwrap(), sel);
    }

    #[test]
    fn selection_across_folders_is_rejected() {
        let err = shell_selection(vec![p("/w/a.zip"), p("/w/sub/b.zip")]).unwrap_err();
        assert!(matches!(err, DuetError::NotSupported(_)), "{err:?}");
    }

    #[test]
    fn parent_compare_is_by_path_not_string() {
        // 끝 구분자·중복 구분자 차이는 같은 부모로 본다(Path 컴포넌트 비교).
        let sel = vec![p("/w/a.zip"), p("/w//b.zip")];
        assert!(shell_selection(sel).is_ok());
    }

    #[test]
    fn dotdot_segment_is_rejected() {
        // 글자상 부모는 둘 다 /w/sub 지만 sub/.. 는 /w 자체다.
        let err = shell_selection(vec![p("/w/sub/.."), p("/w/sub/a.zip")]).unwrap_err();
        assert!(matches!(err, DuetError::NotSupported(_)), "{err:?}");
        assert!(shell_selection(vec![p("/w/../x/a.zip")]).is_err());
    }

    #[test]
    fn dot_segment_is_rejected() {
        assert!(shell_selection(vec![p("./a.zip")]).is_err());
        // Path::components 가 지우는 중간·끝 "." 도 거부.
        assert!(shell_selection(vec![p("/w/./a.zip")]).is_err());
        assert!(shell_selection(vec![p("/w/sub/.")]).is_err());
        assert!(shell_selection(vec![p(r"C:\w\.\a.zip")]).is_err());
    }

    #[test]
    fn dotted_names_are_not_dot_segments() {
        let sel = vec![p("/w/.hidden"), p("/w/a..zip"), p("/w/..b")];
        assert_eq!(shell_selection(sel.clone()).unwrap(), sel);
    }

    #[test]
    fn empty_selection_is_rejected() {
        let err = shell_selection(Vec::new()).unwrap_err();
        assert!(matches!(err, DuetError::NotSupported(_)), "{err:?}");
    }

    #[test]
    fn roots_share_the_no_parent_group() {
        assert!(Path::new("/").parent().is_none());
        assert!(shell_selection(vec![p("/")]).is_ok());
        assert!(shell_selection(vec![p("/"), p("/w")]).is_err());
    }

    type Key = (Vec<PathBuf>, u8);

    fn key(paths: &[&str]) -> Key {
        (paths.iter().map(|s| p(s)).collect(), 0)
    }

    #[test]
    fn tokens_are_unique_and_never_zero() {
        let mut c: SessionCache<Key, &str> = SessionCache::new(4);
        let a = c.issue_token();
        let b = c.issue_token();
        assert_ne!(a, 0);
        assert_ne!(a, b);
    }

    #[test]
    fn rebuilt_key_rejects_the_old_token() {
        let mut c: SessionCache<Key, &str> = SessionCache::new(4);
        let k = key(&["/w/a.zip", "/w/b.zip"]);
        let old = c.issue_token();
        assert!(c.insert(k.clone(), old, "first").is_empty());
        let new = c.issue_token();
        let replaced = c.insert(k.clone(), new, "second");
        assert_eq!(replaced, vec![(k.clone(), "first")]);
        // 옛 token 은 같은 키의 새 세션으로 풀리면 안 된다.
        assert!(c.resolve(old).is_none());
        assert_eq!(c.resolve(new), Some((&k, &"second")));
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn selection_order_is_part_of_the_key() {
        let mut c: SessionCache<Key, &str> = SessionCache::new(4);
        let ab = key(&["/w/a", "/w/b"]);
        let ba = key(&["/w/b", "/w/a"]);
        let t1 = c.issue_token();
        c.insert(ab.clone(), t1, "ab");
        assert!(c.get(&ba).is_none());
        assert_eq!(c.get(&ab), Some((t1, &"ab")));
    }

    #[test]
    fn eviction_drops_the_token_too() {
        let mut c: SessionCache<Key, &str> = SessionCache::new(2);
        let (k1, k2, k3) = (key(&["/w/1"]), key(&["/w/2"]), key(&["/w/3"]));
        let t1 = c.issue_token();
        c.insert(k1.clone(), t1, "1");
        let t2 = c.issue_token();
        c.insert(k2.clone(), t2, "2");
        let t3 = c.issue_token();
        let evicted = c.insert(k3.clone(), t3, "3");
        assert_eq!(evicted, vec![(k1, "1")]);
        assert!(c.resolve(t1).is_none());
        assert!(c.resolve(t2).is_some());
        assert!(c.resolve(t3).is_some());
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn removed_session_token_is_stale() {
        let mut c: SessionCache<Key, &str> = SessionCache::new(4);
        let k = key(&["/w/a"]);
        let t = c.issue_token();
        c.insert(k.clone(), t, "a");
        assert_eq!(c.remove(&k), Some("a"));
        assert!(c.resolve(t).is_none());
        assert!(c.remove(&k).is_none());
    }

    #[test]
    fn unknown_token_is_stale() {
        let c: SessionCache<Key, &str> = SessionCache::new(4);
        assert!(c.resolve(0).is_none());
        assert!(c.resolve(42).is_none());
    }

    #[test]
    fn background_takes_exactly_one_folder() {
        assert_eq!(
            shell_target(vec![p("/w")], ShellScope::Background).unwrap(),
            vec![p("/w")]
        );
        assert!(shell_target(vec![p("/w/a"), p("/w/b")], ShellScope::Background).is_err());
        assert!(shell_target(Vec::new(), ShellScope::Background).is_err());
    }

    #[test]
    fn item_scopes_keep_multi_selection() {
        let sel = vec![p("/w/a"), p("/w/b")];
        assert_eq!(shell_target(sel.clone(), ShellScope::File).unwrap(), sel);
        assert_eq!(
            shell_target(sel.clone(), ShellScope::Directory).unwrap(),
            sel
        );
        assert!(shell_target(vec![p("/w/a"), p("/x/b")], ShellScope::File).is_err());
    }

    #[test]
    fn stale_menu_is_not_found() {
        assert!(matches!(stale_menu_error(), DuetError::NotFound(_)));
    }

    #[test]
    fn user_cancel_hresults_map_to_cancelled() {
        assert!(matches!(
            invoke_error(0x8007_04C7_u32 as i32, "x"),
            DuetError::Cancelled
        ));
        assert!(matches!(
            invoke_error(0x8000_4004_u32 as i32, "x"),
            DuetError::Cancelled
        ));
    }

    #[test]
    fn other_invoke_failures_keep_message_and_code() {
        match invoke_error(0x8000_4005_u32 as i32, " Unspecified error\r\n") {
            DuetError::Io(m) => {
                assert!(m.contains("Unspecified error"), "{m}");
                assert!(m.contains("0x80004005"), "{m}");
            }
            other => panic!("expected Io, got {other:?}"),
        }
    }
}
