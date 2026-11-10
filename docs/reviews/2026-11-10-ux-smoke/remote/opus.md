# remote — ux-remote-opus 보고 (Round 1)

> 상태: **코드·테스트 작성 완료, 컴파일·실행 대기(cargo 슬롯)**. 아래 "결과" 칸의 `대기` 는 슬롯을
> 받은 뒤 채운다. 커밋 해시는 fixup 정리(autosquash) 후 바뀔 수 있다 — 최종 해시는 맨 아래 표.

브랜치 `ux-smoke/remote-opus` (base 76b9b6e), worktree `/tmp/duet-ux-smoke-worktrees/remote-opus`.

## 한 줄 요약

- **G-10 (remote-05/06/07)**: 세션 `Mutex` 제거(공유 `Handle`), 채널 열기 20초 상한, 연결 전체(모든
  jump hop 포함) 30초 상한, 원격 검색 취소 시 원격 명령에 SIGTERM+채널 닫기.
- **remote-03**: 원격 링크 종류 판정 수정(링크가 전부 "파일"로 보이던 것), 재귀 순회는 폴더 링크를
  따라가지 않는 `list_for_walk` 로.

## 커밋

| 커밋 | 내용 |
|---|---|
| d93f9f7 | test: chaos 테스트가 팀별 컨테이너(`DUET_SSH_IT_CHAOS`)를 쓰게 |
| 1a08cd1 (+fixup 800dc31) | be/ssh: 연결 전체 상한 `CONNECT_TIMEOUT`=30s (remote-06) + 단위 테스트 3 |
| 4067083 (+fixup 00a8a00, 5757f89) | be/ssh: 세션 Mutex 제거, 채널 열기 상한 `CHANNEL_OPEN_TIMEOUT`=20s, `exec_cancellable` (remote-05/07) |
| 2f1ca61 | be/ssh: 원격 검색 취소가 원격 명령을 멈춤 (remote-07) |
| 0cc062d (+fixup ebcc8fb) | test: remote-05/06/07 측정 → 회귀 테스트 |
| 85a9708 | be/fs: `FileSystem::list_for_walk` (기본 구현은 fs/mod.rs, fs/local.rs 무수정) |
| 23c08ea (+fixup e97bb74) | be/core: compare·3-way·백업 수집이 링크를 따라가지 않음 + 테스트 |
| 9fe7819 | be/fs: SFTP 파일 종류 정확 판정 + SshFs `list_for_walk` + docker 테스트 |

## G-10 — 무엇을 바꿨나

- `ActiveConnection.session: Option<Handle>` (Mutex 제거) + `ActiveConnection::handle()`.
  근거: russh 0.46 소스 확인 — `Handle { sender: mpsc::Sender, receiver: UnboundedReceiver<Reply>,
  join }`, `channel_open_session`/`channel_open_direct_tcpip`/`disconnect`/`is_closed` 모두 `&self`,
  채널마다 확인 응답 큐가 따로(`wait_channel_confirmation` 이 채널 전용 receiver 사용). `&mut self` 는
  인증 메서드뿐(연결 단계, 풀 등록 전). `Send+Sync` 는 `review_remote_opus_handle::handle_is_send_and_sync`
  컴파일 테스트.
- `ssh::remote_exec`: `open_session`(20초 상한, 초과 시 `ConnectionFailed("…timed out…")` — FE 가
  연결 시간 초과 문구로 표시), exec/stdin/streaming 이 한 `start`+`pump` 경로 공유(명령 본문 비노출 §5
  유지, 정적 테스트 갱신), `exec_cancellable`(취소 → `signal(TERM)` + `close()` → `Cancelled`).
  russh 0.46 `Channel` 에는 Drop 이 없어 버리기만 하면 서버에 아무것도 안 감 — 그래서 명시 close.
- `ssh::connection`: 공개 연결 함수 4개(`connect`, `connect_with_{key,agent,password}`) 전부
  `within_deadline(30s)`. `connect` 는 jump 체인 전체를 한 상한 안에.
- 기계적 수정(리드 승인): core/ops.rs 14곳, core/archive.rs 1, core/search.rs 2(취소 연결 포함, 함수
  안 `use` 1줄씩), commands/connection.rs 2+생성 1, commands/search.rs 1, services/connection_supervisor.rs
  확인+생성, services/fs_watcher.rs(채널 열기 상한 적용 — 처음 목록에 없던 곳), tests/ssh_common·chaos·sol_r2.
  `&handle` → `handle`(clippy needless_borrow 회피). ops.rs 의 낡은 TODO(perf: mutex) 주석을 사실로 교체.

### 일부러 안 한 것 (G-10 한계)

- **같은 서버 cp/rsync 실행 중 취소**: 지금처럼 항목 경계에서만. 실행 중 끊으면 반쯤 쓴 대상이
  journal 밖에 남음 → fileops / G-09 후속(파괴적 취소 경로는 journal 없이 만들지 않음, main 지시).
- exec 자체에는 전체 상한 없음(긴 명령은 정상). 실행 중 서버가 멈추면 keepalive 끊김(~75초)까지.
- SFTP 요청은 russh-sftp 기본 10초 상한(채널 연 뒤).
- 배너 수동 재연결의 [취소] 버튼(FE)은 없음 — 대신 30초 상한으로 끝남.
- `signal` 은 서버 의존: OpenSSH sshd 는 세션 프로세스 그룹에 보냄(소스 기억 — docker 9.7 실측으로 확인
  예정). 지원 안 하는 서버는 close 만 → 출력 없는 명령은 계속 돌 수 있음.
- 기존: 풀 등록 시 `session.handle` 만 옮겨 `_jump_sessions` 는 즉시 drop(터널 채널이 sender 를 쥐어
  동작은 함). 이번 범위 밖, 기록만.

## remote-03 — 무엇을 바꿨나

- 원인(라이브러리 소스 확인): russh-sftp 2.1.2 `is_regular()`/`is_dir()` 는 비트 포함 검사 —
  링크 0xA000 ⊃ REG 0x8000, 소켓 0xC000·블록 0x6000 ⊃ DIR 0x4000. `file_type()` 은 종류 필드 전체를
  비교해 정확. SshFs `list`/`metadata`/`symlink_metadata`/`remove_recursive` 를 `entry_kind()`(=file_type)로.
- `list`(화면): LocalFs 와 같은 약속 — 폴더 링크 `Dir`, 파일 링크 `File`, 깨진·루프 링크 `Symlink`.
- `list_for_walk`(순회): 폴더 링크만 `Symlink`. 기본 구현(LocalFs 등) = `list` + Dir 항목 lstat 1회,
  lstat 실패 시 `list` 값 유지(호출부 오류 처리 불변). SshFs 는 readdir lstat 속성으로(왕복 추가 0).
- 걷는 쪽 3곳 token swap: `compare::compare_into`, `three_way::walk`(오류 처리 그대로 — sync 조건 1),
  `ops::collect_backup_files`. `mirror_dir`/`prune_pass` 무수정(sync 조건 3).

### 바뀐 로컬 동작 (sync 조건: 문서화)

- 로컬 비교·3-way 에서 **양쪽(또는 2쪽 이상)에 있는 폴더 링크**는 이제 한 줄(`Symlink`)이고 안으로
  내려가지 않는다. 예전엔 `dl/secret.txt` 같은 링크 대상 안 파일이 행으로 나왔고, `up -> ..`/`self -> .`
  루프는 경로 길이 한계까지 내려갔다(링크 2개면 사실상 끝나지 않음).
- 그런 행을 적용(apply/merge/3-way)하면 **링크 대상 내용을 복사하지 않고 그 행이 오류**로 끝난다
  (`copy_tree` 가 lstat 로 링크를 보고 대상 스트림을 열다 폴더라 실패. `.duet-part` 빈 파일이 남을 수
  있음 = 기존 G-19). 링크를 링크로 복사하는 건 fileops 후속(`read_link` 가 trait 에 없음).
- 위험 감소: 예전 로컬 3-way 에서 폴더 링크 아래로 내려가 "삭제 전파"가 나면 **비교 트리 밖** 파일
  (링크 대상)을 휴지통으로 보낼 수 있었다. 이제 링크 자체만 다룬다.
- 한쪽에만 있는 폴더(링크든 아니든)는 원래 한 줄 — 변화 없음.

### 원격에서 닿는 재귀 소비처 전수 (main 요청)

| 소비처 | 위치 | 원격 도달 | 재귀 방식 | remote-03 후 | 조치 |
|---|---|---|---|---|---|
| 패널 목록·이동 | commands/pane.rs | 예 | 재귀 아님 | 폴더 링크 `Dir` → 들어갈 수 있음 | 목적 |
| relay 복사/이동(업·다운로드) | fs/mod.rs `copy_tree` | 예 | lstat(`symlink_metadata`) | 링크=`Symlink` → 단일 항목(파일 링크는 내용, 폴더 링크는 실패). 예전 원격 lstat 은 `File` → 같은 갈래 | 변화 없음 |
| 같은 서버 복사/이동 | ops `cp -a`/`rsync -a` | 예 | 서버측, 링크 보존 | 무관 | — |
| 휴지통 | fs/ssh.rs `trash` | 예 | rename(링크 자체) | 무관 | — |
| 영구 삭제 | fs/ssh.rs `remove_recursive` | 예 | lstat | 링크=링크만 삭제(전과 같음). 소켓·블록을 폴더로 오판하던 것도 수정 | 수정 |
| 폴더 크기 | fs/ssh.rs `dir_size` (`du -sb`) | 예 | du 기본 no-follow | 무관 (browse-18 은 별건, 미수정) | — |
| 원격 검색/인덱스 | core/search.rs, commands/search.rs (`find`) | 예 | find 기본 `-P` | 무관 | — |
| 비교 | core/compare.rs `compare_into` | 예 | `list` 종류 | 새로 따라갈 뻔 | `list_for_walk` |
| 3-way 비교/적용 | core/three_way.rs `walk` | 예 | `list` 종류 | 새로 따라갈 뻔 | `list_for_walk` |
| 같은 서버 sync undo 백업 수집 | ops `collect_backup_files` | 예(same-host) | `list` 종류 | 새로 따라가 **링크 대상 파일을 dst 로 "복원"** 할 뻔 | `list_for_walk` |
| sync 개수 세기 | ops `count_files` | UI 로는 아니오. 생 IPC `fs_sync_execute` 로 relay 계획을 보내면 가능(Sol R1) | `list` 종류 | — | **`list_for_walk`** (8613828, sync 결정) |
| sync 실행(로컬 미러) | ops `mirror_dir`/`prune_pass` | UI 로는 아니오. 생 IPC 로는 가능(`ensure_current_same_host` 가 SshSameHost 만 검사) | `list` 종류 | 원격 링크를 따라갈 수 있음 | 무수정(sync SC-01/SC-06). **sync 가 sync_execute/sync_preview 에서 Relay 거부(sync round 2)** |
| sync 미리보기 | ops `preview_copy_walk`/`preview_prune_walk` | UI 로는 아니오(FE 가 `fsSyncPlan` 먼저 — relay 거부, 대화상자는 그 plan 의 src/dst 로 미리보기). 생 IPC 로만 가능 | `list` 종류 | — | **`list_for_walk`** (8613828, sync 결정). 로컬 미리보기는 이제 링크 안을 보이지 않음(mirror 는 SC-06 까지 그대로) |
| sudo staging 업로드 | core/sudo.rs `upload_tree` | 예(same-host 원격 원본) | `metadata`=stat(따라감) | **변화 없음**: 원격 stat 은 원래 폴더 링크를 Dir 로 줬다(버그는 lstat·list 만) | 기존 위험 기록 — remote/G-12 후속 |
| 실행 기록 지문 | core/stamp.rs `collect_tree` | 예 | `list`+lstat 재확인 | 원격 링크가 `File`→`Symlink` 로 기록 | 안전. 업그레이드 전 기록의 원격 트리에 링크가 있으면 undo 가 "바뀜"으로 건너뜀(안전 쪽) |
| undo 이름/빈 폴더 확인 | core/undo.rs, undo/cleanup.rs | 예 | 재귀 아님 | 무관 | — |
| 압축(원격) | core/archive.rs (`zip -r`/`tar`) | 예 | 서버측 명령 | 무관(`zip -y` 는 기존 후속) | — |
| 압축 repack 계획 | core/archive.rs:1029 | 예 | 재귀 아님 | 무관 | — |
| 원격 볼륨 | commands/system.rs `ssh_volumes_in` | 예 | 재귀 아님 | `/mnt` 등의 폴더 링크가 이제 보임(예전 `File` 이라 걸러짐) | 개선 |
| 변경 감시 | services/fs_watcher.rs | 예 | stat 1회 | 무관 | — |

### 증거 요구 항목 (main)

| 항목 | 테스트 | 종류 | 결과 |
|---|---|---|---|
| 링크가 루트 | `remote03_sftp_links` (Lroot 비교), `remote03_walk_links::default_list_for_walk…`(dl 안 목록) | docker / unit | 대기 |
| 상대·절대 대상 | `dl -> ../outside`, `abs -> <절대>` 둘 다 | docker / unit | 대기 |
| 깨진 링크 | `broken -> nowhere`: list·walk=`Symlink`, stat=오류 | docker / unit | 대기 |
| 루프 | `up -> ..`, `self -> .`, 20~60초 상한 안에 끝남 | docker / unit | 대기 |
| 비-UTF8 이름 | `odd/<0xff>` — 관찰 기록(기존 동작) | docker | 대기 |
| lstat/list 오류 | 읽기 불가 폴더(안에 링크): list·walk 둘 다 PermissionDenied. 기본 구현 lstat 실패 = list 값 유지(문서) | docker / 정적 | 대기 |
| 적용이 링크 대상 내용을 복사하지 않음 | `apply_on_folder_link_rows…`, `merge_and_three_way_apply…` (로컬 + 원격 흉내) | unit(TempDir) | 대기 |

## 실행 기록

환경: docker 29.2.1, 이미지 `duet-remote-opus-ssh`(fixture Dockerfile, OpenSSH 9.7p1),
컨테이너 `duet-remote-opus-ssh` :2232, chaos `duet-remote-opus-chaos` :2233. 격리 HOME =
`src-tauri/tests/fixtures/ssh/it-home`(gitignored), known_hosts 는 컨테이너 공개키로 채움.
cargo: `CARGO_TARGET_DIR=/tmp/duet-ux-target-remote CARGO_BUILD_JOBS=2 --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0`.

- 기준선(base): 첫 시도는 main 의 cargo freeze 로 SIGINT(제품 문제 아님) → 슬롯 대기. 2026-11-08 보고의
  base 수치: 멈춘 서버에서 목록/exec/검색 74.98s, 연결 330s+, 긴 exec 중 목록 7.70s/9.76s.
- (슬롯 후 기록)

## 남은 것

- 위 G-10 한계, sync 미리보기 전략 가드 권고, sudo `upload_tree` stat 재귀(기존), 링크를 링크로 복사(fileops).
- `review_remote_sol_r2::long_exec_does_not_delay_the_supervisor_check` 는 포트 2225 고정 — 실행 여부 기록 예정.

## 체크포인트 (2026-11-10, 리드 요청)

- **커밋 안 된 작업 없음** (`git status` 깨끗, `_report/` 만 미추적). wip patch 불필요.
- **컴파일·테스트: 아직 cargo 0회** (freeze → 팀 슬롯 대기). 정적 검토만: russh 0.46·russh-sftp 2.1.2
  소스 대조, `rustfmt --check` 변경 파일 전부 통과. 컴파일 오류 가능성 있음 — 첫 슬롯에서 확인.
- remote-03: 코드·테스트 완료(커밋됨), 실행 대기. 걷는 쪽은 3곳만 swap(리드·sync 조건 반영).
- fixup 커밋 4개(800dc31, 00a8a00, ebcc8fb, e97bb74)는 게이트 통과 후
  `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash 76b9b6e` 로 접는다(해시 바뀜 → 리드에 재보고).

### 다음 cargo 명령 (순서대로, 슬롯 받은 뒤)

```bash
cd /tmp/duet-ux-smoke-worktrees/remote-opus/src-tauri
F=$PWD/tests/fixtures/ssh
export CARGO_TARGET_DIR=/tmp/duet-ux-target-remote CARGO_BUILD_JOBS=2
C="--config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0"
# 1) 단위 (lib)
cargo test $C --lib -- ssh:: fs::ssh fs:: services::connection_pool core::search services::retry
# 2) 로컬 통합(링크 순회, TempDir)
cargo test $C --test remote03_walk_links
# 3) docker IT (컨테이너 :2232, chaos :2233 — 떠 있어야 함)
env HOME=$F/it-home SSH_AUTH_SOCK= DUET_SSH_IT=1 DUET_SSH_IT_PORT=2232 DUET_SSH_IT_KEY=$F/keys/id_ed25519 \
  cargo test $C --test 'ssh_it_*' --test review_remote_opus_handle --test remote03_sftp_links -- --ignored --test-threads=1
env HOME=$F/it-home SSH_AUTH_SOCK= DUET_SSH_IT=1 DUET_SSH_IT_PORT=2232 DUET_SSH_IT_KEY=$F/keys/id_ed25519 \
  cargo test $C --test review_remote_opus_sftp -- --ignored --test-threads=1 c14_list_and_metadata c15_file_ops
env HOME=$F/it-home SSH_AUTH_SOCK= DUET_SSH_IT=1 DUET_SSH_IT_PORT=2233 DUET_SSH_IT_CHAOS=duet-remote-opus-chaos DUET_SSH_IT_KEY=$F/keys/id_ed25519 \
  cargo test $C --test review_remote_opus_chaos -- --ignored --test-threads=1 c11_ c13bc_ c13_long_exec
# 4) main 게이트(리드가 조율): 전체 cargo test --lib, clippy --all-targets -D warnings (core/ops.rs 등 기계적 수정 포함)
```
- 기준선(base) 실행은 선택: 같은 명령을 `WT=/tmp/duet-ux-smoke-worktrees/remote-opus-base`(detached 76b9b6e
  + d93f9f7 테스트 패치)에서. 슬롯이 빠듯하면 2026-11-08 수치로 대체.

## 정적 자기 검토 (2026-11-11, cargo 없이)

- 제품 코드 diff 에 `unwrap`/`expect`/`println!`/`unsafe` 없음(unwrap 2개는 connection.rs 테스트 모듈).
- 공개 항목 doc 주석 확인. `channel_open_timed_out` 은 내부 전용이라 비공개로(fixup 5757f89).
- three_way.rs 는 순수 3줄 token swap, compare.rs 는 token 2개 + rustfmt 재배치(`git diff -w` 로 6줄).
- 500줄 초과: `ssh/connection.rs` 1392(이전 1203), `fs/ssh.rs` 981(이전 970) — 원래 초과, 늘어난 건 대부분 테스트.
- Sol 리뷰 인계: `_report/HANDOFF-SOL.md`.

## Sol R1 정적 지적 반영 (2026-11-11)

1. 테스트의 낡은 `Some(Mutex::new(handle))` 2곳(sol_r2:209, opus_sftp:857) → `Some(x.handle)` (fixup 02b2a68 → 4067083).
   `tests/` 전체에 `Mutex::new(…handle)`·`session…lock()` 남은 것 없음(grep).
2. `remote03_sftp_links` 비교가 빈 로컬 폴더와 비교해 링크 검사가 공허했던 것 → 로컬 R 에 같은 이름의
   폴더 링크·진짜 폴더를 둠, 파일에 `#![cfg(unix)]` (fixup fe126e2 → 9fe7819).
3. 감사 빈틈(생 IPC 로 relay 계획 → count/mirror/prune·미리보기): **실제 FE 경로로는 닿지 않음** —
   `triggerSync` 는 항상 `fsSyncPlan` 먼저(Relay 거부), SyncDialog 미리보기는 그 plan 의 src/dst,
   실행(`App.tsx:1561`)은 백엔드가 만든 plan 을 그대로 돌려보냄. sync 결정에 따라 count/미리보기는
   `list_for_walk`(8613828, 테스트 `core/ops_walk_links_tests.rs`), mirror/prune 은 sync 가 Relay 거부로 막음.

### 통합 순서 (main 에게)

- **9fe7819 (SshFs 가 폴더 링크를 Dir 로 분류)는 sync 의 Relay-거부 커밋 뒤에 통합해야 한다.**
  그 전엔 생 IPC 로 relay 계획을 보내면 mirror_dir/prune_pass 가 원격 폴더 링크를 따라갈 수 있다.
- 브랜치 안에서도 8613828 이 9fe7819 뒤에 있다 — autosquash 때 8613828 을 9fe7819 앞으로 옮긴다
  (순회 쪽이 먼저 링크를 안 따라가게 된 뒤 분류를 고치는 순서, bisect 안전).

## Sol BE R1 B1·B2 반영 (2026-11-11, cargo 없이)

- **B1 (채널 열기 시간 초과 누수)** — russh 0.46 확인: 늦게 온 `CHANNEL_OPEN_CONFIRMATION` 은 받는 쪽이
  없으면 `send(..).unwrap_or(())` 로 버려지고(`client/encrypted.rs:401-428`), 서버 채널은 열린 채, 닫기도
  안 감. 수정: 풀이 `Arc<Handle>` 를 들고(`ActiveConnection.session: Option<Arc<Handle>>`), `open_session`
  은 열기 future 가 `Arc` 를 소유 → 시간 초과 시 그 future 를 spawn 해 `LATE_OPEN_GRACE`(120s) 동안 더
  기다리다 열리면 즉시 `close()`. 단위 테스트 `remote_exec::late_open_tests` — 메모리 안 russh 서버
  (`tokio::io::duplex` + `server::run_stream`)가 열기 확인을 300ms 늦추고 `channel_close` 를 센다;
  50ms 상한으로 포기 → 늦은 확인 뒤 닫기 1회 도착을 확인. 생성자(commands/connection.rs, supervisor,
  테스트 3곳) `Arc::new`, sol_ssh 테스트는 소유 핸들을 `Arc` 로. fixup **ef9e4f2** (→ 4067083).
- **B2 (기본 list_for_walk 가 lstat 실패 시 Dir 유지)** — fail closed: lstat 실패면 목록 전체 오류.
  고른 이유: 걷는 쪽 모두 목록 오류를 이미 다룬다(비교 = Unreadable 행, count/미리보기/백업 수집 =
  빈/최선, 3-way = 그 쪽 빈 목록 — SC-05 가 고치는 기존 목록 오류 경로). 잎으로 바꾸면 3-way 가 종류
  불일치로 "바뀜" 처리해 적용할 수 있어 더 위험. 또 lstat 이 Dir 아닌 다른 종류를 말하면 그 종류를 따름.
  LocalFs `list` 는 lstat 안 되는 항목을 빼므로 실제로는 목록·lstat 사이 경합만 해당.
  fixup **96d931b** (→ 85a9708) + 테스트 fixup **4af7519** (→ 23c08ea): lstat 실패 mock → 오류,
  비교는 Unreadable 한 줄; lstat 종류 변경 mock → Dir 없음.
- B3(위조 LocalToLocal 계획 가드)는 sync 담당 — 조치 없음.

## 실행 결과 — remote 슬롯 (2026-11-11, 리드 지정 명령만)

공통: `cd src-tauri; CARGO_TARGET_DIR=/tmp/duet-ux-target-remote CARGO_BUILD_JOBS=2 cargo test --config profile.test.package.duet.opt-level=0 --config profile.test.package.duet.debug=0 …`.
docker = 컨테이너 `duet-remote-opus-ssh` :2232 / chaos `duet-remote-opus-chaos` :2233 (OpenSSH 9.7p1),
`HOME=tests/fixtures/ssh/it-home SSH_AUTH_SOCK= DUET_SSH_IT=1 DUET_SSH_IT_KEY=tests/fixtures/ssh/keys/id_ed25519`.
HEAD 당시 fe126e2…4af7519 (fixup 미정리).

| 단계 | 명령 | 종류 | 결과 |
|---|---|---|---|
| 3 | `--lib -- ssh:: fs::ssh services::connection_pool core::search services::retry` | unit | **ok 77 passed, 0 failed, 2 ignored**(기존 sync repro). 경고 0. 새 테스트 포함: late_open(메모리 russh 서버), connect 상한 직접·jump, entry_kind/linked_kind |
| 4a | `--test 'ssh_it_*' --test review_remote_opus_handle -- --ignored --test-threads=1` (:2232) | live docker | **ok 21 passed** (ssh_it 18 + handle 3). 취소 → 원격 `sleep 3171 \| cat` 파이프라인 없음(취소 후 ~4ms 반환, OpenSSH 9.7 signal=프로세스 그룹 확인). 실행 중 닫기 21µs, 진행 중 exec 은 `channel closed without ExitStatus` 오류로 끝남. 5초 exec 중 같은 핸들 목록 25.6ms |
| 4b | `--test review_remote_opus_chaos -- --ignored --test-threads=1 c11_ c13bc_ c13_long_exec` (:2233, `DUET_SSH_IT_CHAOS=duet-remote-opus-chaos`) | live docker | **2 passed, 1 failed (테스트 결함)**. c11: 멈춘 서버 연결 30.0s, 블랙홀 192.0.2.1 30.0s (base: 330s+/무기한). c13bc: 멈춤 중 목록·exec·검색 각각 20.0s 에 `opening a channel timed out after 20s` (base 74.98s), keepalive 끊김 75.2s. c13: 8초 exec 중 목록 10.0ms (base 7.70s), 세션 확인 542ns. **실패**: 작은 컨테이너에서 `find /` 가 157ms 에 끝나 200ms 취소 전에 `Ok` → 테스트가 `Cancelled` 만 기대. 수정 bd8e57b(Ok 이면서 취소 전 종료도 허용) — **재실행 필요** |
| 5a | `--lib -- core::ops core::compare core::three_way fs::` | unit | **183 passed, 1 failed**. `ops_paths_tests::relay_count_and_preview_walks_use_each_filesystem` — 그 mock(ProbeFs)이 lstat 을 구현 안 해 기본 metadata(항상 NotFound)로 떨어짐 → B2 fail-closed 로 목록 오류 → count 0. 수정 0a9f59b(mock 에 목록 있는 경로 = 진짜 폴더 lstat). **재실행 필요**. 내 `ops_walk_links_tests` 3개는 통과 |
| 5b | `--test remote03_walk_links` | unit(TempDir) | **ok 9 passed**. 폴더 링크 행 적용·병합·3-way 는 `copy read: Is a directory` 로 그 행만 실패, 대상 내용 복사 없음(로컬·원격 흉내 둘 다) |
| 6 | `--test remote03_sftp_links -- --ignored --test-threads=1` (:2232) | live docker | **ok 1 passed**. 원격 L 과 링크 루트 Lroot 둘 다 링크(dl·abs·up·self) 한 줄, `real/inner.txt` 만 내려감. broken: list·walk `Symlink`, stat NotFound. 비-UTF8 `bad\xffname` → 목록은 되지만 이름이 `bad�name` 으로 손실 변환(기존 동작 — 그 이름으로 작업하면 다른 경로, 후속). 읽기 불가 폴더: list·walk 둘 다 PermissionDenied |

- 실행 안 한 것(리드 목록 밖): `review_remote_opus_sftp` c14/c15, `review_remote_sol_r2`(2225 고정), chaos 의 relay 800MB 측정 2개, clippy·전체 스위트.
- **재실행 요청(리드 lease 필요)**: `--lib -- core::ops::ops_paths_tests` 와 chaos `c13_long_exec` (위 두 테스트 수정 확인).
