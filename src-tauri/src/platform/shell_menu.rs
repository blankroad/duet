//! Tier 2: 실제 셸 컨텍스트 메뉴(IContextMenu) 호스팅 — Explorer/TC 와 동일하게 셸에
//! 위임해 이름·필터·COM 핸들러(7-Zip 등)·서브메뉴를 정확히 가져온다.
//!
//! **핫 스레드**: COM STA 전용 스레드를 *하나만* 앱 수명 내내 살려둔다(CoUninitialize 안
//! 함). 그래야 셸 확장 핸들러가 메모리에 따뜻하게 남아, 탐색기처럼 둘째 우클릭부터 빠르다.
//! (매 클릭마다 스레드+COM 을 차갑게 재로딩하던 게 느림의 근본 원인이었다.)
//!
//! 흐름: 명령은 Build/Invoke/Close 요청을 채널로 워커에 보낸다. 워커가 IContextMenu+HMENU
//! 를 만들어 token 으로 보관(COM 객체는 이 스레드에 affinity), Build 응답으로 enumerate 한
//! items 를 돌려준다. 프론트가 항목 클릭 시 Invoke(token, id), 메뉴 닫힘 시 Close(token).
//!
//! **스냅샷 캐시**: 빌드 결과의 (token, items) 는 워커 밖 `Mutex` 맵에도 복사해 둔다. 우클릭
//! (Open)이 캐시 히트면 채널을 아예 안 거치고 명령 스레드에서 즉시 응답 — 진행 중인 예열
//! 빌드(수 초)가 STA 를 점유하고 있어도 안 밀린다. COM 객체는 여전히 워커 스레드 전용.
//!
//! 모든 COM 호출은 unsafe — platform/ 한정(§8). 의존성 `windows`(§6 승인).

use std::collections::HashMap;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::{E_FAIL, E_INVALIDARG, HWND};
use windows::Win32::Graphics::Gdi::HBITMAP;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    IContextMenu, ILFindLastID, IShellFolder, SHBindToParent, SHParseDisplayName, CMF_NORMAL,
    CMINVOKECOMMANDINFO,
};
use windows::Win32::UI::WindowsAndMessaging::HMENU;
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetMenuItemCount, GetMenuItemInfoW, MENUITEMINFOW, MFS_DISABLED,
    MFS_GRAYED, MFT_SEPARATOR, MIIM_BITMAP, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING,
    MIIM_SUBMENU, SW_SHOWNORMAL,
};

use crate::platform::shell_menu_core::{invoke_error, stale_menu_error, SessionCache};
use crate::platform::{ShellMenuItem, ShellScope};
use crate::types::DuetError;

const ID_FIRST: u32 = 1;
const ID_LAST: u32 = 0x7FFF;
const MAX_DEPTH: u32 = 6;
/// 캐시에 보관하는 빌드된 메뉴 상한 — 초과 시 오래된 것부터 파기(COM 객체 누수 방지).
const MAX_OPEN: usize = 16;
/// 캐시 안전망 TTL — 이보다 오래된 캐시는 Open 시 재빌드. 신선도는 주로 FE 의 재-warm
/// (커서 이동/폴더 변경)이 관리하고, 이건 "오래 방치된 메뉴를 무한정 재사용" 방지용.
const CACHE_TTL: Duration = Duration::from_secs(300);

/// 워커로 보내는 요청. `paths` 는 한 폴더 안의 선택(표시 순서) — 명령 레이어가
/// `shell_menu_core::shell_selection` 으로 검증한 것만 들어온다.
enum Req {
    /// 실제 우클릭 — 캐시 있으면 즉시, 없으면 빌드. **절대 supersede 로 skip 되지 않는다**
    /// (표시되는 메뉴라 항상 실제 결과를 돌려줘야 함). 워커가 token 을 발급/재사용해 반환.
    Open {
        hwnd: isize,
        paths: Vec<PathBuf>,
        scope: ShellScope,
        reply: tokio::sync::oneshot::Sender<(u64, Vec<ShellMenuItem>)>,
        /// enqueue 시각 — 워커 큐 대기시간 계측(직렬 워커라 앞선 작업에 밀릴 수 있음).
        queued_at: Instant,
    },
    /// 백그라운드 캐시 채움(커서 멈춤/변경 시) — best-effort. 이미 신선하면 skip, 여러 개면
    /// 마지막 것만. Open 을 절대 밀어내지 않는다(그래서 렌더가 안 깨진다).
    Warm {
        hwnd: isize,
        paths: Vec<PathBuf>,
        scope: ShellScope,
    },
    /// 메뉴 항목 실행 — 결과(만료·실패·취소)를 `reply` 로 돌려준다(프론트가 토스트).
    Invoke {
        token: u64,
        cmd_id: u32,
        reply: InvokeReply,
    },
    /// 핸들러 예열 — 메뉴를 만들었다 바로 버린다(셸 확장 COM 을 메모리에 로드만). 단일 경로.
    Prewarm { hwnd: isize, path: PathBuf },
}

/// `SHParseDisplayName` 이 할당한 절대 PIDL 들의 소유자 — Drop 에서 각각 정확히 한 번
/// `CoTaskMemFree`. 자식 PIDL(`ILFindLastID`)은 이 안을 가리키므로, 이 값은 그 자식들을 넘긴
/// IContextMenu 가 살아 있는 동안(QueryContextMenu·InvokeCommand 내내) 같이 살아야 한다.
struct AbsPidls(Vec<*mut ITEMIDLIST>);

impl Drop for AbsPidls {
    fn drop(&mut self) {
        for pidl in self.0.drain(..) {
            // SAFETY: SHParseDisplayName 이 CoTaskMemAlloc 으로 준 non-null PIDL 만 담긴다
            // (build_menu 가 성공한 것만 push). drain 이라 같은 포인터를 두 번 해제하지 않는다.
            unsafe { CoTaskMemFree(Some(pidl as *const _)) };
        }
    }
}

/// 빌드된 셸 메뉴 세션 — STA 워커 스레드 전용(COM affinity).
///
/// 정리 순서: `Drop` 이 HMENU 를 파기한 뒤 필드가 선언 순서로 drop 된다 —
/// IContextMenu Release → 부모 IShellFolder Release → 절대 PIDL 해제. 메뉴 객체가 먼저
/// 놓여야 그 객체가 아직 참조할 수 있는 PIDL 을 먼저 풀지 않는다.
struct Session {
    hmenu: HMENU,
    cm: IContextMenu,
    _parent: IShellFolder,
    _pidls: AbsPidls,
}

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: build_menu 가 CreatePopupMenu 로 만든 우리 HMENU. 이 스레드에서 한 번만 파기.
        unsafe {
            let _ = DestroyMenu(self.hmenu);
        }
    }
}

/// 캐시된 빌드 결과 — COM 세션은 이 STA 스레드에만 affinity. invoke 까지 살아 있어야.
struct Cached {
    session: Session,
    hwnd: isize,
    items: Vec<ShellMenuItem>,
    built_at: Instant,
}

/// (선택 경로 목록(순서 포함), scope) 캐시 키 — 같은 항목이라도 순서·구성이 다르면 다른 메뉴.
type Key = (Vec<PathBuf>, ShellScope);

/// 워커 밖(명령 스레드)에서 읽는 빌드 결과 복사본 — 캐시 히트를 STA 큐에 안 태우기 위함.
/// COM 객체는 워커 스레드 affinity 라 여기 두지 않는다. token 만 들고 있다가 invoke 시
/// 워커가 그 token 으로 자기 세션을 찾는다. 워커 캐시와 항상 같이 갱신/파기된다.
struct Snapshot {
    token: u64,
    items: Vec<ShellMenuItem>,
    built_at: Instant,
}

/// 스냅샷 맵 — 워커 스레드와 명령 스레드가 공유. 잠금 구간은 맵 조회/복사뿐(COM 호출 없음).
type SharedCache = Arc<Mutex<HashMap<Key, Snapshot>>>;

/// 핫 COM 스레드 핸들 — 명령 레이어가 Build/Invoke/Close 를 보낸다. 첫 사용 시 lazy 생성.
pub struct Worker {
    tx: mpsc::Sender<Req>,
    shared: SharedCache,
}

impl Worker {
    /// COM STA 워커 스레드 spawn (앱 수명 내내 유지). 한 번만 호출(레지스트리 OnceLock).
    pub fn start() -> Worker {
        let (tx, rx) = mpsc::channel::<Req>();
        let shared: SharedCache = Arc::new(Mutex::new(HashMap::new()));
        let (worker_shared, self_tx) = (shared.clone(), tx.clone());
        std::thread::spawn(move || worker_loop(rx, worker_shared, self_tx));
        Worker { tx, shared }
    }

    /// 우클릭 — 캐시 있으면 즉시, 없으면 빌드. (token, items) 반환(채널 끊기면 빈 결과).
    /// token 은 빌드마다 새로 발급 — invoke 는 이 token 으로 그 선택의 IContextMenu 를 찾는다.
    ///
    /// 캐시 히트는 **채널을 안 거친다** — 진행 중인 예열 빌드(최대 수 초)가 STA 를 점유해도
    /// 우클릭이 그 뒤에 줄 서지 않게. TTL 지난 stale 스냅샷도 그대로 즉시 서빙한다: COM
    /// 세션은 살아 있어 invoke 는 정확하고, 갱신은 다음 warm(호버/커서 정지)이 맡는다.
    /// (여기서 재빌드를 걸면 지금 열리는 메뉴의 세션을 파기해 클릭이 무시될 수 있다.)
    pub async fn open(
        &self,
        hwnd: isize,
        paths: Vec<PathBuf>,
        scope: ShellScope,
    ) -> (u64, Vec<ShellMenuItem>) {
        let key: Key = (paths, scope);
        if let Some(hit) = self.snapshot(&key) {
            return hit;
        }
        let (reply, rx) = tokio::sync::oneshot::channel();
        if self
            .tx
            .send(Req::Open {
                hwnd,
                paths: key.0,
                scope,
                reply,
                queued_at: Instant::now(),
            })
            .is_err()
        {
            return (0, Vec::new());
        }
        rx.await.unwrap_or((0, Vec::new()))
    }

    /// 스냅샷 조회 — 있으면 (token, items) 복사본. 잠금 실패(poison)면 미스로 취급.
    fn snapshot(&self, key: &Key) -> Option<(u64, Vec<ShellMenuItem>)> {
        let map = self.shared.lock().ok()?;
        let s = map.get(key)?;
        Some((s.token, s.items.clone()))
    }

    /// 백그라운드 캐시 채움(커서/호버 멈춤, 폴더 변경 시) — fire-and-forget.
    /// 이미 신선하면 채널조차 안 건드린다(호버 예열이 자주 불려도 큐가 안 쌓이게).
    pub fn warm(&self, hwnd: isize, paths: Vec<PathBuf>, scope: ShellScope) {
        let key: Key = (paths, scope);
        let fresh = self.shared.lock().ok().is_some_and(|m| {
            m.get(&key)
                .is_some_and(|s| s.built_at.elapsed() < CACHE_TTL)
        });
        if fresh {
            return;
        }
        let _ = self.tx.send(Req::Warm {
            hwnd,
            paths: key.0,
            scope,
        });
    }

    /// 메뉴 항목 실행. token 이 지금 살아 있는 세션이 아니면 아무것도 실행하지 않고
    /// `NotFound`(만료), InvokeCommand 실패는 `Io`, 사용자 취소는 `Cancelled`.
    pub async fn invoke(&self, token: u64, cmd_id: u32) -> Result<(), DuetError> {
        let stopped = || DuetError::Io("shell menu worker stopped".into());
        let (reply, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(Req::Invoke {
                token,
                cmd_id,
                reply,
            })
            .map_err(|_| stopped())?;
        rx.await.map_err(|_| stopped())?
    }

    /// 시작 시 호출 — 셸 핸들러를 백그라운드로 예열(첫 우클릭도 빠르게).
    pub fn prewarm(&self, hwnd: isize, path: PathBuf) {
        let _ = self.tx.send(Req::Prewarm { hwnd, path });
    }
}

/// 워커 상태 — 선택 캐시(STA 스레드 소유). COM 객체는 이 스레드에만 affinity.
struct State {
    /// (선택, scope) → 빌드된 세션 + token 역인덱스 + 삽입 순서. 꺼낸 값을 버리면 Drop 이
    /// HMENU·COM·PIDL 을 정리한다. 파기·교체된 세션의 token 은 다시 풀리지 않는다.
    cache: SessionCache<Key, Cached>,
    /// 명령 스레드가 읽는 스냅샷 맵 — `cache` 와 항상 함께 갱신/파기(세션 없는 token 금지).
    shared: SharedCache,
}

impl State {
    fn fresh(&self, key: &Key) -> bool {
        self.cache
            .get(key)
            .is_some_and(|(_, c)| c.built_at.elapsed() < CACHE_TTL)
    }

    /// 캐시 엔트리 하나 파기 — 세션은 여기서 drop(이 스레드). 스냅샷도 같이 지운다 — 세션
    /// 없는 token 을 프론트에 주면 invoke 가 stale 로 거부된다.
    fn drop_entry(&mut self, key: &Key) {
        drop(self.cache.remove(key));
        if let Ok(mut m) = self.shared.lock() {
            m.remove(key);
        }
    }

    /// 선택 메뉴를 빌드해 캐시에 넣고 (token, items) 반환. 기존 엔트리는 교체.
    /// 빌드 실패 시 새 token + 빈 items(세션 없음 → invoke 는 stale 로 거부).
    fn build_and_cache(
        &mut self,
        hwnd: isize,
        key: Key,
        wait_ms: u64,
    ) -> (u64, Vec<ShellMenuItem>) {
        self.drop_entry(&key); // 같은 선택 재빌드면 오래된 COM 객체 먼저 파기.
        let token = self.cache.issue_token();

        let t_build = Instant::now();
        // SAFETY: 셸 객체 생성/열거는 이 스레드에서만.
        match unsafe { build_menu(HWND(hwnd as *mut _), &key.0) } {
            Ok((session, phases)) => {
                let build_ms = t_build.elapsed().as_millis() as u64;
                let mut stats = EnumStats::default();
                let t_enum = Instant::now();
                // SAFETY: session.hmenu 는 방금 채운 살아 있는 HMENU(이 스레드).
                let items = unsafe { enumerate(session.hmenu, 0, &mut stats) };
                tracing::info!(
                    token,
                    wait_ms,
                    build_ms,
                    paths = key.0.len(),
                    parse_ms = phases.parse_ms,
                    query_ms = phases.query_ms,
                    enum_ms = t_enum.elapsed().as_millis() as u64,
                    items = stats.items,
                    icons = stats.icons,
                    icon_ms = stats.icon_time.as_millis() as u64,
                    "shell menu build"
                );
                // 진단(C): 어떤 셸 확장이 메뉴에 끼어드는지 최상위 라벨을 남긴다.
                let labels: Vec<&str> = items
                    .iter()
                    .filter(|i| !i.separator && !i.label.is_empty())
                    .map(|i| i.label.as_str())
                    .collect();
                tracing::info!(token, query_ms = phases.query_ms, labels = %labels.join(" | "), "shell menu items");

                let built_at = Instant::now();
                let evicted = self.cache.insert(
                    key.clone(),
                    token,
                    Cached {
                        session,
                        hwnd,
                        items: items.clone(),
                        built_at,
                    },
                );
                // 명령 스레드가 채널 없이 읽어갈 복사본 — 우클릭 히트가 STA 큐를 안 타게.
                // 밀려난 세션의 스냅샷을 먼저 지우고(그 token 은 이제 stale) 새 것을 넣는다.
                if let Ok(mut m) = self.shared.lock() {
                    for (old, _) in &evicted {
                        m.remove(old);
                    }
                    m.insert(
                        key,
                        Snapshot {
                            token,
                            items: items.clone(),
                            built_at,
                        },
                    );
                }
                drop(evicted); // 세션 Drop(HMENU·COM·PIDL 정리) — 이 스레드에서.
                (token, items)
            }
            Err(e) => {
                tracing::warn!(token, wait_ms, paths = key.0.len(), error = %e, "shell menu build failed");
                (token, Vec::new())
            }
        }
    }

    /// token 의 세션으로 명령 실행 후 그 엔트리 파기(실행이 상태를 바꿀 수 있음). 실행 결과와,
    /// 실행 직후 같은 선택을 다시 예열하도록 (hwnd, key) 를 돌려준다.
    ///
    /// token 이 지금 살아 있는 세션을 가리키지 않으면(파기·교체·빌드 실패) **아무것도 실행하지
    /// 않고** `NotFound` — 같은 선택이 새로 빌드돼 있어도 그 새 메뉴의 명령으로 풀지 않는다.
    fn invoke(&mut self, token: u64, cmd_id: u32) -> (Result<(), DuetError>, Option<(isize, Key)>) {
        let Some((key, c)) = self.cache.resolve(token) else {
            tracing::warn!(
                token,
                cmd_id,
                "shell menu invoke ignored: stale token (menu rebuilt, evicted or failed)"
            );
            return (Err(stale_menu_error()), None);
        };
        let (key, hwnd) = (key.clone(), c.hwnd);
        let result = if (ID_FIRST..=ID_LAST).contains(&cmd_id) {
            // SAFETY: cm 은 이 스레드에서 만든 살아있는 IContextMenu. 그 PIDL 들은 세션이 보유.
            unsafe { invoke(&c.session.cm, HWND(c.hwnd as *mut _), cmd_id) }.map_err(|e| {
                tracing::warn!(token, cmd_id, error = %e, "shell menu invoke failed");
                invoke_error(e.code().0, &e.message())
            })
        } else {
            tracing::warn!(
                token,
                cmd_id,
                "shell menu invoke ignored: command id out of range"
            );
            Err(DuetError::NotSupported(
                "shell menu: command id out of range".into(),
            ))
        };
        self.drop_entry(&key);
        (result, Some((hwnd, key)))
    }
}

/// 워커 루프 — COM 한 번 초기화(끝까지 유지), 요청을 직렬 처리. IContextMenu 는 이 스레드에만.
///
/// `self_tx` 는 워커가 스스로에게 후속 작업(invoke 후 재예열)을 예약하는 채널. 이 클론을
/// 들고 있으므로 채널은 끊기지 않고, 스레드는 앱 수명 내내 산다(원래 의도한 수명).
fn worker_loop(rx: mpsc::Receiver<Req>, shared: SharedCache, self_tx: mpsc::Sender<Req>) {
    // SAFETY: 이 스레드용 STA COM 초기화. CoUninitialize 안 함(핸들러 warm 유지가 목적).
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

    let mut st = State {
        cache: SessionCache::new(MAX_OPEN),
        shared,
    };

    loop {
        let first = match rx.recv() {
            Ok(r) => r,
            Err(_) => break,
        };
        // 밀린 요청을 한 번에 끌어와 정리(직렬 워커 큐 증폭 방지). 종류별로 나눠 처리:
        // - Open(우클릭)은 마지막 것만 빌드하되 **절대 Warm 에 밀려 skip 되지 않는다**
        // - Warm(예열)은 마지막 하나만, 캐시가 신선하지 않을 때만 — Open 을 못 밀어냄
        // - Prewarm(핸들러 예열)은 맨 끝(실제 작업 우선)
        let mut batch = vec![first];
        while let Ok(r) = rx.try_recv() {
            batch.push(r);
        }

        let mut opens: Vec<(isize, Key, OpenReply, Instant)> = Vec::new();
        let mut warms: Vec<(isize, Key)> = Vec::new();
        let mut invokes: Vec<(u64, u32, InvokeReply)> = Vec::new();
        let mut prewarms: Vec<(isize, PathBuf)> = Vec::new();
        for r in batch {
            match r {
                Req::Open {
                    hwnd,
                    paths,
                    scope,
                    reply,
                    queued_at,
                } => opens.push((hwnd, (paths, scope), reply, queued_at)),
                Req::Warm { hwnd, paths, scope } => warms.push((hwnd, (paths, scope))),
                Req::Invoke {
                    token,
                    cmd_id,
                    reply,
                } => invokes.push((token, cmd_id, reply)),
                Req::Prewarm { hwnd, path } => prewarms.push((hwnd, path)),
            }
        }

        // 1) Invoke — 캐시된 세션의 IContextMenu 로 실행 후 그 엔트리 파기.
        for (token, cmd_id, reply) in invokes {
            let (result, rewarm) = st.invoke(token, cmd_id);
            let _ = reply.send(result);
            // 실행 직후 같은 선택을 백그라운드 재예열 — 안 그러면 방금 쓴 항목의 다음
            // 우클릭이 다시 cold 다. self-send 라 이번 배치의 Open 을 늦추지 않는다.
            // (실행이 대상을 없앴을 수 있으니 선택 전부가 아직 있을 때만 — 빌드 실패 로그 방지.)
            if let Some((hwnd, (paths, scope))) = rewarm {
                if paths.iter().all(|p| p.exists()) {
                    let _ = self_tx.send(Req::Warm { hwnd, paths, scope });
                }
            }
        }

        // 2) Open — 마지막 것만 필요 시 빌드(앞선 것은 이미 닫힌 메뉴). 캐시 hit 은 즉시.
        let last_open = opens.len().saturating_sub(1);
        for (i, (hwnd, key, reply, queued_at)) in opens.into_iter().enumerate() {
            if st.fresh(&key) {
                if let Some((token, c)) = st.cache.get(&key) {
                    let _ = reply.send((token, c.items.clone()));
                }
            } else if i == last_open {
                let wait_ms = queued_at.elapsed().as_millis() as u64;
                let out = st.build_and_cache(hwnd, key, wait_ms);
                let _ = reply.send(out);
            } else {
                // 더 새 Open 존재 — 이 메뉴는 이미 닫힘. 빈 응답(FE 는 null 처리).
                tracing::info!("shell menu open skipped (superseded)");
                let _ = reply.send((0, Vec::new()));
            }
        }

        // 3) Warm — **scope 별로** 마지막 것만, 캐시가 신선하지 않을 때만 빌드.
        // scope 별로 나누는 이유: 항목(file/directory) 예열과 빈 영역(background) 예열이
        // 한 배치에 같이 오면 예전엔 뒤엣것 하나만 살아 남아, 폴더 진입 시 둘 중 하나는
        // 영영 cold 였다. 같은 scope 안에서는 여전히 마지막 하나만(호버 폭주 흡수).
        let mut last_by_scope: Vec<(isize, Key)> = Vec::new();
        for (hwnd, key) in warms {
            if let Some(slot) = last_by_scope.iter_mut().find(|(_, k)| k.1 == key.1) {
                *slot = (hwnd, key);
            } else {
                last_by_scope.push((hwnd, key));
            }
        }
        for (hwnd, key) in last_by_scope {
            if !st.fresh(&key) {
                let _ = st.build_and_cache(hwnd, key, 0);
            }
        }

        // 4) Prewarm(시작 시 핸들러 예열) — 만들고 즉시 버림(세션 Drop 이 정리).
        for (hwnd, path) in prewarms {
            let t = Instant::now();
            // SAFETY: 셸 객체 생성/파기 전부 이 스레드에서.
            let built = unsafe { build_menu(HWND(hwnd as *mut _), std::slice::from_ref(&path)) };
            drop(built);
            tracing::info!(
                elapsed_ms = t.elapsed().as_millis() as u64,
                path = %path.display(),
                "shell menu prewarm"
            );
        }
    }
}

/// Open 응답 채널 타입 별칭 — (token, items).
type OpenReply = tokio::sync::oneshot::Sender<(u64, Vec<ShellMenuItem>)>;

/// Invoke 응답 채널 타입 별칭 — 실행 결과.
type InvokeReply = tokio::sync::oneshot::Sender<Result<(), DuetError>>;

/// build_menu 단계별 소요(ms) — 병목 진단용. parse=PIDL·IContextMenu 획득,
/// query=QueryContextMenu(셸 확장 핸들러 전부 동기 호출 — 통상 지배적 비용).
struct BuildPhases {
    parse_ms: u64,
    query_ms: u64,
}

/// 한 폴더 안의 선택 → IContextMenu + 채워진 HMENU 를 쥔 세션. (모든 호출 unsafe COM)
///
/// Explorer 와 같은 방식: 부모 IShellFolder 를 한 번 바인딩하고, 선택 전부의 자식 PIDL 을
/// 한 번의 `GetUIObjectOf` 에 넘긴다 — 그래야 셸 확장(7-Zip/Bandizip 등)이 N 개를 한 번에
/// 받아 "각각 압축 풀기" 같은 다중 항목 명령을 낸다. 같은 부모인지는 명령 레이어
/// (`shell_menu_core::shell_selection`)가 이미 검증했다.
///
/// 수명: 자식 PIDL 은 절대 PIDL 안을 가리킨다(`ILFindLastID`). 절대 PIDL 은 세션의 `AbsPidls`
/// 가 소유해 세션이 버려질 때 한 번만 해제된다 — QueryContextMenu·InvokeCommand 내내 유효.
unsafe fn build_menu(
    hwnd: HWND,
    paths: &[PathBuf],
) -> windows::core::Result<(Session, BuildPhases)> {
    let t = Instant::now();
    // 경로 → 절대 PIDL. 중간 실패 시 이미 받은 것들은 AbsPidls drop 이 해제.
    let mut pidls = AbsPidls(Vec::with_capacity(paths.len()));
    for path in paths {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None)?;
        if pidl.is_null() {
            return Err(E_FAIL.into());
        }
        pidls.0.push(pidl);
    }
    let first = *pidls
        .0
        .first()
        .ok_or(windows::core::Error::from(E_INVALIDARG))?;

    // 부모 IShellFolder — 첫 항목 기준 한 번만. (riid/ppv 는 제네릭 반환으로 접힘 — windows 0.58)
    let parent: IShellFolder = SHBindToParent(first, None)?;
    // 각 항목의 자식(상대) PIDL — SHBindToParent 의 ppidlLast 와 같은 값(절대 PIDL 의 마지막 ID).
    let children: Vec<*const ITEMIDLIST> = pidls
        .0
        .iter()
        .map(|&p| ILFindLastID(p) as *const ITEMIDLIST)
        .collect();

    // IContextMenu 획득 — 선택 전부를 한 번에.
    let cm: IContextMenu = parent.GetUIObjectOf(hwnd, &children, None)?;
    let parse_ms = t.elapsed().as_millis() as u64;

    // HMENU 구성. 세션을 먼저 묶어 두면 QueryContextMenu 실패 시에도 Drop 이 전부 정리한다.
    let session = Session {
        hmenu: CreatePopupMenu()?,
        cm,
        _parent: parent,
        _pidls: pidls,
    };
    let t = Instant::now();
    session
        .cm
        .QueryContextMenu(session.hmenu, 0, ID_FIRST, ID_LAST, CMF_NORMAL)?;
    let query_ms = t.elapsed().as_millis() as u64;
    Ok((session, BuildPhases { parse_ms, query_ms }))
}

/// enumerate 계측 — 전체(서브메뉴 포함) 항목/아이콘 수와 아이콘 PNG 인코딩 누적 시간.
#[derive(Default)]
struct EnumStats {
    items: u32,
    icons: u32,
    icon_time: Duration,
}

/// HMENU 를 재귀 열거 → ShellMenuItem 트리. (unsafe Win32)
unsafe fn enumerate(hmenu: HMENU, depth: u32, stats: &mut EnumStats) -> Vec<ShellMenuItem> {
    if depth > MAX_DEPTH {
        return Vec::new();
    }
    let count = GetMenuItemCount(hmenu);
    if count <= 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..count {
        let mut buf = [0u16; 260];
        let mut mii = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_STRING | MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE | MIIM_STATE | MIIM_BITMAP,
            dwTypeData: windows::core::PWSTR(buf.as_mut_ptr()),
            cch: buf.len() as u32,
            ..Default::default()
        };
        if GetMenuItemInfoW(hmenu, i as u32, true, &mut mii).is_err() {
            continue;
        }
        let is_sep = (mii.fType.0 & MFT_SEPARATOR.0) != 0;
        if is_sep {
            out.push(ShellMenuItem {
                id: 0,
                label: String::new(),
                separator: true,
                disabled: false,
                children: Vec::new(),
                icon: None,
            });
            continue;
        }
        let label = strip_accelerator(&String::from_utf16_lossy(&buf[..mii.cch as usize]));
        if label.trim().is_empty() {
            continue;
        }
        let disabled = (mii.fState.0 & (MFS_DISABLED.0 | MFS_GRAYED.0)) != 0;
        let children = if !mii.hSubMenu.0.is_null() {
            enumerate(mii.hSubMenu, depth + 1, stats)
        } else {
            Vec::new()
        };
        // 항목 아이콘 — hbmpItem 이 실제 HBITMAP 이면(HBMMENU_* 센티넬 1..=13 / CALLBACK(-1) /
        // null 제외) PNG 로. 셸 확장이 set 한 16px 비트맵.
        let addr = mii.hbmpItem.0 as usize;
        let icon = if addr > 13 && addr != usize::MAX {
            let t = Instant::now();
            let png = hbitmap_to_png(mii.hbmpItem);
            stats.icon_time += t.elapsed();
            if png.is_some() {
                stats.icons += 1;
            }
            png
        } else {
            None
        };
        stats.items += 1;
        out.push(ShellMenuItem {
            id: mii.wID,
            label,
            separator: false,
            disabled,
            children,
            icon,
        });
    }
    out
}

/// HBITMAP(32bpp, 알파 premultiplied 가능) → PNG 바이트. 알파 보존(없으면 불투명).
/// 셸 메뉴 항목 아이콘과 파일 아이콘(`platform::win_file_icon`)이 공용.
///
/// SAFETY: `hbitmap` 은 유효한 GDI 비트맵 핸들이어야 한다.
pub(super) unsafe fn hbitmap_to_png(hbitmap: HBITMAP) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ,
    };

    let mut bmp = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(hbitmap.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bmp as *mut _ as *mut c_void),
    );
    // 메뉴 아이콘은 작음 — 비정상/거대 비트맵은 스킵.
    if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 || bmp.bmWidth > 256 || bmp.bmHeight > 256
    {
        return None;
    }
    let w = bmp.bmWidth;
    let h = bmp.bmHeight;

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let hdc = GetDC(None);
    let scan = GetDIBits(
        hdc,
        hbitmap,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut c_void),
        &mut info,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if scan == 0 {
        return None;
    }

    // BGRA → RGBA. 알파 채널이 전부 0(24bpp 비트맵 등)이면 불투명 처리, 있으면
    // premultiplied 로 보고 straight 로 환산.
    let has_alpha = buf.chunks_exact(4).any(|p| p[3] != 0);
    let mut rgba = Vec::with_capacity(buf.len());
    for p in buf.chunks_exact(4) {
        let (b, g, r, a) = (p[0], p[1], p[2], p[3]);
        if has_alpha {
            let a = a as u32;
            let un = |c: u8| {
                if a > 0 {
                    ((c as u32 * 255 / a).min(255)) as u8
                } else {
                    0
                }
            };
            rgba.push(un(r));
            rgba.push(un(g));
            rgba.push(un(b));
            rgba.push(a as u8);
        } else {
            rgba.push(r);
            rgba.push(g);
            rgba.push(b);
            rgba.push(255);
        }
    }
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)?;
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut out, image::ImageFormat::Png)
        .ok()?;
    Some(out.into_inner())
}

/// 선택한 명령 실행. cmd_id 는 절대 id → InvokeCommand 는 offset(id-ID_FIRST) 필요.
unsafe fn invoke(cm: &IContextMenu, hwnd: HWND, cmd_id: u32) -> windows::core::Result<()> {
    let offset = cmd_id - ID_FIRST;
    let info = CMINVOKECOMMANDINFO {
        cbSize: std::mem::size_of::<CMINVOKECOMMANDINFO>() as u32,
        hwnd,
        lpVerb: PCSTR(offset as usize as *const u8), // MAKEINTRESOURCEA(offset)
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    cm.InvokeCommand(&info)
}

/// 메뉴 라벨에서 `&` 가속기 제거 ("E&dit" → "Edit", "&&" → "&").
fn strip_accelerator(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}
