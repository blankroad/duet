//! 셸 컨텍스트 메뉴의 OS 독립 부분 — 선택 검증·캐시 키와 token↔세션 장부.
//!
//! COM 호출은 `shell_menu.rs`(Windows 전용)에 있고, 여기는 순수 로직만 둔다. 그래야 macOS/Linux
//! 에서도 단위 테스트로 규칙을 고정할 수 있다.
//! - [`shell_selection`]: 다중 선택을 Explorer 처럼 "한 폴더 안의 항목들" 로만 받는다.
//! - [`SessionCache`]: 빌드한 메뉴 세션을 키별로 보관하고 token 으로 찾는다. token 은 빌드마다
//!   새로 발급되므로, 지난 선택의 token 이 새로 빌드된 다른 메뉴로 풀리는 일이 없다.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::path::PathBuf;

use crate::types::DuetError;

/// 셸 메뉴 대상 선택을 검증하고 캐시 키로 쓸 경로 목록을 돌려준다.
///
/// - 각 경로를 [`super::local_abs`] 로 절대경로화한다(드라이브 없는 경로 보정).
/// - 비어 있으면 거부.
/// - 모든 항목의 부모(`Path::parent`, 문자열이 아닌 경로 비교)가 같아야 한다 — 셸은 한 부모
///   폴더의 `GetUIObjectOf` 에 자식들을 한꺼번에 넘기므로, 다른 폴더의 항목은 같이 못 묶는다.
///   드라이브 루트처럼 부모가 없는 경로끼리는 "부모 없음" 으로 같다고 본다.
/// - 순서는 그대로 둔다(화면 표시 순서 = 셸에 넘기는 순서 = 캐시 키).
pub fn shell_selection(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, DuetError> {
    let paths: Vec<PathBuf> = paths.into_iter().map(super::local_abs).collect();
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
}
