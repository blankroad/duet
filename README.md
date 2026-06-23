# duet

> 안전하고 빠른 **듀얼 패널 SSH/SFTP + 로컬 파일 매니저**.
> 모던 GUI · Windows / macOS / Linux · Tauri 2 + React + Rust.

---

## 목차

- [한 줄 설명](#한-줄-설명)
- [왜 만드는가](#왜-만드는가)
- [상태](#상태)
- [빠른 시작](#빠른-시작)
- [핵심 개념 3가지](#핵심-개념-3가지)
- [기능 상세](#기능-상세)
  - [1. 듀얼 패널 · 뷰 · 네비게이션](#1-듀얼-패널--뷰--네비게이션)
  - [2. 선택 · 드래그 앤 드롭](#2-선택--드래그-앤-드롭)
  - [3. 파일 작업 (복사·이동·이름변경·새폴더)](#3-파일-작업-복사이동이름변경새폴더)
  - [4. 안전망 — 휴지통 · 영구삭제 · Undo · 충돌 백업](#4-안전망--휴지통--영구삭제--undo--충돌-백업)
  - [5. SSH / SFTP](#5-ssh--sftp)
  - [6. 자격증명 보관 (Secret Vault)](#6-자격증명-보관-secret-vault)
  - [7. 같은 호스트 직접 복사 (핵심 차별점)](#7-같은-호스트-직접-복사-핵심-차별점)
  - [8. 작업 큐 · 진행률 · 취소](#8-작업-큐--진행률--취소)
  - [9. 미리보기 & Quick Look](#9-미리보기--quick-look)
  - [10. 검색 (글로벌 + 인덱스)](#10-검색-글로벌--인덱스)
  - [11. 폴더 비교 · 3-way · 동기화](#11-폴더-비교--3-way--동기화)
  - [12. 압축 / 해제 / 아카이브 내부 탐색](#12-압축--해제--아카이브-내부-탐색)
  - [13. 일괄 이름변경 (Batch Rename)](#13-일괄-이름변경-batch-rename)
  - [14. 커맨드 팔레트](#14-커맨드-팔레트)
  - [15. 사이드바 (Places · Volumes · 북마크 · 즐겨찾기 · 호스트)](#15-사이드바-places--volumes--북마크--즐겨찾기--호스트)
  - [16. 앱 런처](#16-앱-런처)
  - [17. 컨텍스트 메뉴 & OS 셸 통합](#17-컨텍스트-메뉴--os-셸-통합)
- [키보드 단축키](#키보드-단축키)
- [설정](#설정)
- [설정·데이터 파일 위치](#설정데이터-파일-위치)
- [아키텍처 개요](#아키텍처-개요)
- [빌드 · 테스트](#빌드--테스트)
- [기술 스택](#기술-스택)
- [보안·안전 원칙](#보안안전-원칙)
- [문서 읽는 순서](#문서-읽는-순서)

---

## 한 줄 설명

Tauri + React 기반의 듀얼 패널 파일 매니저. **같은 호스트의 두 SFTP 패널 간 복사는
원격에서 직접 `cp`/`rsync` 를 실행**해 네트워크 왕복을 없앤다. **영구 삭제가 기본
비활성화된 안전한 휴지통 모델**과, **모든 파괴적 작업을 되돌릴 수 있는 undo(저널)**
시스템이 핵심이다.

## 왜 만드는가

기존 도구들의 구체적인 문제를 해결하려고 만들었다.

- **TC(Total Commander):** Symantec DLP 충돌, 휴지통 동작 시 멈춤, 같은 호스트 SFTP
  간 복사 시 본인 PC를 거치는 네트워크 왕복 (10GB 파일이 30분 → 5분이면 될 일)
- **WinSCP / FileZilla 등:** 듀얼 패널이 약하거나 없음
- **yazi / ranger:** TUI라 GUI 워크플로우와 안 맞음
- **ForkLift / Path Finder:** 유료 + macOS 전용

## 상태

✅ **기능 완성.** MVP-0 ~ MVP-7 + 장기(Maybe) 항목 대부분 구현 완료.
백엔드(Rust) 약 21k LOC, 프론트엔드(TS/React) 약 19k LOC, Tauri command 약 110개.

본인용 도구로 만들었으며 외부 배포 패키징은 고려하지 않는다. 단계별 진행 상황은
[`ROADMAP.md`](./ROADMAP.md) 참고.

---

## 빠른 시작

```bash
# 의존성 설치
pnpm install

# 개발 모드 (핫 리로드)
pnpm tauri dev

# 릴리즈 빌드 (.exe / .msi / .app / .deb 등)
pnpm tauri build
```

처음 실행하면 양쪽 패널 모두 로컬 홈 디렉토리로 시작한다. 한쪽 패널을 원격으로
바꾸려면 사이드바의 SSH 호스트를 더블클릭하거나 `Ctrl+P → "Connect..."`.

> **Windows 빌드 사전 준비:** Visual Studio Build Tools(C++) + Rust(MSVC) + Node +
> pnpm + WebView2. `russh` 가 순수 Rust crypto라 NASM/CMake/OpenSSL은 **불필요**.

---

## 핵심 개념 3가지

duet를 이해하는 가장 빠른 길은 다음 3가지다.

| 개념 | 무엇인가 | 왜 중요한가 |
|---|---|---|
| **같은 호스트 직접 복사** | 두 패널이 같은 SSH 머신을 가리키면 복사를 그 서버 안에서 `cp`/`rsync` 로 실행 | 본인 PC를 거치지 않음 → 대용량이 수십 배 빠름. duet의 존재 이유 |
| **안전한 삭제** | 삭제 = 휴지통 이동이 기본. 영구 삭제는 설정에서 켜야 하고, 켜도 `delete` 타이핑 확인 | "실수로 영구 삭제" 가 구조적으로 불가능 |
| **모든 작업 Undo** | 복사·이동·이름변경·삭제·동기화 등이 저널(`journal.jsonl`)에 기록되어 `Ctrl+Z` 로 되돌아감 (세션 간 영속) | 되돌릴 수 없는 작업은 디자인 실패로 간주 |

---

## 기능 상세

### 1. 듀얼 패널 · 뷰 · 네비게이션

- **듀얼 패널**: 좌/우 두 패널. 클릭한 패널이 활성(accent 테두리)이 되고, 키보드는
  활성 패널에만 적용된다. `Tab` 으로 패널 전환, `Ctrl+U` 로 좌우 swap, 활성 탭을
  반대 패널로 이동하는 명령(`tab.moveToOther`)도 있다.
- **뷰 모드 3종** (패널·탭별로 독립):
  - **Details** — 정렬 가능한 컬럼 테이블(이름 / 확장자 / 크기 / 수정일 / 타입).
    헤더 클릭으로 정렬 키·방향 토글.
  - **Grid** — 아이콘+라벨 셀 격자(셀 폭 ~120px 자동 컬럼).
  - **Tiles** — 한 줄에 아이콘·이름·메타데이터를 묶은 48px 행.
- **가상 스크롤** (`@tanstack/react-virtual`): 수만 개 항목도 끊김 없이 렌더.
- **네비게이션**:
  - `↑/↓` 커서 이동(그리드는 컬럼 수만큼 상하 이동), `Enter` 진입/열기,
    `Backspace` 상위 폴더(아카이브 탐색 중이면 아카이브 밖으로).
  - **히스토리 back/forward** (`Alt+←/→`) — 탭당 스택, 최대 100개.
  - **주소창** (PathBar): 브레드크럼 세그먼트 클릭으로 점프, `Ctrl+L` 로 절대경로 직접
    입력. 뒤로/앞으로/상위/새로고침/북마크(⭐) 버튼 제공. 아카이브 탐색 중이면 경로
    바에 아카이브 라벨 + "Update archive(repack)" 버튼이 뜬다.
- **탭** (패널당, 세션 내): `Ctrl+T` 새 탭, `Ctrl+W` 닫기, `Ctrl+Tab`/`Ctrl+Shift+Tab`
  순환, `+` 버튼으로 현재 위치에 새 탭.
- **정렬**: 이름 / 크기 / 수정일 / 타입 / 확장자 (`Ctrl+Shift+1..5` 또는 컬럼 헤더).
- **필터**: `Ctrl+F` 로 현재 패널 내 부분문자열 필터(대소문자 무시).
- **숨김 토글**: `Ctrl+H` (dotfile 기본 숨김).
- **Places/Volumes 가 활성 패널에 적응**: 왼쪽=원격·오른쪽=로컬이면 포커스에 따라
  사이드바가 해당 시스템의 홈/표준폴더/마운트로 자동 전환된다.

### 2. 선택 · 드래그 앤 드롭

- **마우스 선택**:
  - 클릭 = 단일 선택, `Ctrl/Cmd+클릭` = 토글, `Shift+클릭` = 범위 선택.
  - **마키(고무줄) 선택** — 빈 영역 드래그로 범위 선택(`..` 부모 항목 제외, 필터/숨김
    상태 존중).
- **키보드 선택**: `Ctrl/Cmd+Space` 로 커서 항목 선택 토글.
- **커서 vs 선택**: 커서는 단일 위치, 선택은 집합. 작업은 선택이 있으면 선택을, 없으면
  커서 항목을 대상으로 한다.
- **패널 간 드래그**: 항목을 반대 패널/폴더로 끌면 복사(기본) / `Ctrl`=이동. 드롭 대상
  패널·폴더에 accent 링 하이라이트, 드래그 고스트 라벨 표시.
- **OS 드래그-아웃**: 로컬 파일을 외부 앱으로 끌어내기(`@crabnebula/tauri-plugin-drag`).
  항상 복사(원본 보존).
- **OS 드래그-인**: 탐색기/Finder에서 파일을 패널에 떨어뜨리면 복사 확인 다이얼로그로
  연결(`fs_copy_plan_external`).

### 3. 파일 작업 (복사·이동·이름변경·새폴더)

모든 파괴적 작업은 **plan → execute 2단계**다. plan 단계에서 대상을 스캔하고 충돌을
미리 감지해 확인 다이얼로그를 띄운 뒤, execute 단계에서 실제 수행하며 저널에 기록한다.

- **복사** `F5` / **이동** `F6` — 반대 패널 위치로. 충돌 시 정책 선택(덮어쓰기 / 건너뛰기
  / 둘 다 보존). 덮어쓰기는 기존 파일을 `name.bak.<timestamp>` 로 백업한 뒤 진행한다.
- **이름 변경** `F2` — 다중 선택 시 [일괄 이름변경](#13-일괄-이름변경-batch-rename) 으로.
- **새 폴더** `F7`.
- **클립보드 방식 복사/이동**: `Ctrl+C`(복사 표시) / `Ctrl+X`(이동 표시) / `Ctrl+V`(붙여넣기).
- **경로 복사**: `Ctrl+Shift+C` 전체 경로(forward-slash 통일) / `Ctrl+Alt+C` 파일명만.

부분 실패 안전성: 10개 중 5개까지 복사된 뒤 실패해도, 저널이 "성공한 것"만 기록하므로
undo가 정확하게 동작한다.

### 4. 안전망 — 휴지통 · 영구삭제 · Undo · 충돌 백업

duet의 가장 중요한 부분.

- **휴지통이 기본**:
  - 로컬: OS 휴지통(`trash` crate). macOS는 OS 제약상 앱 내 복원 미지원 → Finder에서 수동.
    Windows 로컬 휴지통은 셸 가상폴더라 탐색기로 열린다.
  - 원격: `<remote-home>/.duet-trash/<batch-id>/<원본 절대경로>/` 로 `mv`.
    batch-id = `YYYYMMDD-HHMMSS-<uuid>`. 원본 구조를 보존해 복원이 정확하다.
  - 원격 휴지통은 다른 파일시스템(EXDEV)이어도 동작: atomic `rename` 실패 시 서버측
    `cp -a` + 원본 제거로 폴백. mv 자체가 실패하면 작업을 abort(영구삭제 폴백 절대 금지).
- **영구 삭제는 기본 OFF**: 설정에서 켜야 가능하고, 켜진 상태에서도 단어 `delete` 를
  직접 타이핑하는 확인을 한 번 더 거친다(`Shift+Delete`). 이 게이트는 **백엔드에서**
  검증한다(프론트 단독 차단 아님).
- **Undo (`Ctrl+Z`)**: 모든 파괴적 작업이 저널(`<config>/duet/journal.jsonl`,
  append-only JSONL, uuid v7 정렬)에 기록된다. N단계 스택, **세션 간 영속**.
  되돌릴 수 있는 작업 종류:
  - 휴지통 → 원위치 복원(로컬은 trash id, 원격은 batch 디렉토리)
  - 복사 → 복사본 제거 + 백업 복원
  - 이동 → 원위치 되돌리기 + 백업 복원
  - 동기화 / 양방향 머지 / 비교 적용 / 3-way 적용 → 생성분 제거 + 백업·prune 복원
  - 일괄 이름변경 → 모든 쌍을 한 번에 원복
  - **영구 삭제만 `Irreversible`** — undo 시도 시 명시적 실패
- **충돌 백업**: 덮어쓰기가 발생하는 모든 경로에서 `name.bak.<UTC ts>` 백업 생성
  (timestamp 충돌 시 `.<n>` 재시도).

### 5. SSH / SFTP

순수 Rust(`russh` / `russh-sftp`) 구현. 시스템 `ssh`/`scp`/`sftp` 바이너리를 **호출하지
않는다** → 사용자/OS별 SSH 클라이언트 환경 차이(Windows OpenSSH 유무 등)를 흡수한다.

- **연결 소스 3종**:
  - **`~/.ssh/config` 호스트** — 표준 config 파싱(`ssh2-config`). IdentityFile/ProxyJump
    포함. 사이드바에 표시되며, 보안상 프론트에는 alias/host/port/user/proxyjump 유무만
    노출(키 경로·점프 별칭은 숨김).
  - **저장 호스트(Saved Hosts)** — 자주 쓰는 ad-hoc 대상 스냅샷(host/port/user/key_path).
    **비밀번호는 저장 안 함.** `<config>/duet/saved-hosts.json`.
  - **즉석 연결(Ad-hoc)** — host/user(필수) + port/key_path(선택) 직접 입력. "Save host"
    체크 시 저장 호스트로 기록(비번 제외).
- **인증 시도 순서**(엄격):
  1. `~/.ssh/config` 의 `IdentityFile`
  2. 기본 키(`~/.ssh/id_ed25519` → `id_ecdsa` → `id_rsa`)
  3. ssh-agent (Unix, `SSH_AUTH_SOCK`)
  4. 비밀번호 — 1~3이 모두 `AuthFailed` 일 때만 다이얼로그(`<input type=password>`).
     컴포넌트 local state 에만 두고 사용 직후 clear, 백엔드도 drop 시 zeroize 노력
     (CLAUDE.md §5).
- **호스트 키 검증(TOFU)**: 처음 보는 호스트 키는 `HostKeyPrompt` 로 사용자에게 확인.
- **패스워드리스 설정**(ssh-copy-id 동등): 비번 접속 후 `Ctrl+P → "Set up passwordless
  login"`. 로컬 **공개키**를 russh exec로 원격 `~/.ssh/authorized_keys` 에 설치
  (umask 077, 중복 제거, 권한 700/600 설정, 마지막에 grep으로 실제 설치 검증). 이후
  키 인증으로 자동 접속. 개인키/passphrase는 절대 건드리지 않는다.
- **ProxyJump (N-hop)**: `~/.ssh/config` 의 ProxyJump 체인을 russh nested session
  (`channel_open_direct_tcpip`)으로 구현. 시스템 ssh 점프 호출 없음.
- **자동 재연결 + 백오프**: 연결당 health checker가 5초 폴링(keepalive 15초 × 3 miss ≈
  45초 감지). 백오프 1s→2s→4s→8s→16s→30s(6회). `AuthFailed` 또는 config에서 호스트
  별칭 제거 시 즉시 포기.
- **변경 감지**: 로컬은 `notify`(즉시), 원격은 활성 패널 디렉토리 mtime을 3초 폴링
  + 포커스 복귀 시 강제 갱신. → `fs:changed` 이벤트.
- **같은 호스트 식별**: 연결 직후 `peer_addr()`(getpeername)로 잡은 peer IP를
  `SourceId::Ssh.host_ip` 에 저장. DNS/alias/config 표기 차이를 모두 흡수.

### 6. 자격증명 보관 (Secret Vault)

선택적으로 SSH 비밀번호를 암호화 저장할 수 있다.

- **암호화**: `age` crate passphrase 모드(scrypt + ChaCha20-Poly1305).
- **파일**: `<config>/duet/secrets.age` (JSON dict `{alias: password}` 을 암호화).
- **마스터 비밀번호 흐름**: 최초 unlock 시 새 vault 생성, 이후 unlock 시 복호화.
  마스터 비번은 잠금 해제 동안만 메모리에 캐시되고, lock 시 zeroize. 디스크/localStorage
  에 절대 저장하지 않는다(CLAUDE.md §5). `MasterPasswordDialog` 로 생성/해제.
- 잠금 상태에선 get/set 불가, set/remove는 임시파일+rename으로 원자적으로 디스크 반영.

### 7. 같은 호스트 직접 복사 (핵심 차별점)

복사 전략은 양쪽 패널의 소스로 자동 결정된다.

| 상황 | 전략 | 동작 |
|---|---|---|
| 로컬 → 로컬 | `LocalToLocal` | `tokio::fs::copy` |
| 같은 SSH 머신(host_ip 일치) | `SshSameHost` | **서버에서 직접 `rsync -a`/`cp -a` 실행** |
| 로컬 ↔ 원격, 다른 호스트 | `Relay` | 본인 PC를 거치는 chunk 스트리밍 |

- **같은 호스트**(peer IP 일치, user가 달라도 OK)면 SSH exec 채널로 서버 안에서 직접
  실행 → 네트워크 왕복 없음. 진행률은 `rsync --info=progress2` 파싱(바이트/%/속도/ETA).
  덮어쓰기는 `rsync --backup-dir` 로 백업, dry-run `rsync -ain` 의 itemize 파싱으로
  생성 파일을 추적해 정확한 undo 제공.
- **Relay**(다른 호스트)는 256KB chunk 스트리밍으로 메모리 사용을 묶고(대용량 OOM 해소),
  연결 끊김 시 1회 재시도하며 `.part` 파일 오프셋부터 **재개**한다.
- 같은 호스트인데 Relay로 떨어지면 절대 silent 폴백하지 않고 경고/에러로 알린다
  (CLAUDE.md 금지 항목).

### 8. 작업 큐 · 진행률 · 취소

- **호스트당 FIFO worker**: 작업은 `HostKey`(Local 또는 Ssh{IP})별 큐에 들어가 순차
  실행된다. 동시에 다른 호스트 작업은 병렬.
- **TasksBar**(상태바 위): 작업 1개면 진행률 한 줄 + 취소 버튼, 2개 이상이면 요약 +
  드롭다운으로 전체 목록. 작업 없으면 자동 숨김.
- **취소**: `CancellationToken` 으로 항목 경계 단위 취소. 큐 대기 중 취소는 즉시 반영.
- **재시도**: 연결/채널 오류(ConnectionFailed, "channel closed"/"EOF"/"broken pipe")만
  3초 sleep 후 1회 재시도. 권한/NotFound는 즉시 실패.

### 9. 미리보기 & Quick Look

- **미리보기 패널**(`F11` 토글): 커서(또는 hover) 항목을 표시.
  - 이미지(PNG/JPG/GIF/WebP/AVIF/BMP/SVG), 텍스트/코드(하이라이트), Markdown(렌더),
    PDF(pdf.js), 미디어(오디오/비디오 HTML5 플레이어).
  - 미리보기 불가 시 **Inspector**(이름/타입/크기/수정일/권한) 표시. 150ms 디바운스.
- **Quick Look**(`Space`): Finder식 전체화면 오버레이. `↑/↓` 로 항목 이동하며 즉시 교체,
  `Esc`/`Space` 로 닫기.
- **스트리밍 방식**: 커스텀 프로토콜 `duet-preview://` + **HTTP Range(206)** 지원.
  비디오/PDF seek 가능. 원격 파일도 SFTP `read_range` 로 부분만 가져온다(전체 다운로드
  안 함). Range 없는 이미지는 16MB 상한.

### 10. 검색 (글로벌 + 인덱스)

- **글로벌 검색** `Ctrl+Shift+F` (파일명 / 내용):
  - 로컬: `ignore` crate(`.gitignore`·`.git/exclude` 자동 존중). 내용 검색은 UTF-8
    텍스트만(8MB 초과·바이너리 스킵).
  - 원격: 파일명은 `find -iname`, 내용은 `rg -F`(없으면 `grep -rlIF`).
  - 새 검색이 이전 검색을 취소(토큰 회전), `search_cancel` 로 중단.
- **인덱스 검색**(Everything 스타일 즉시 검색): 메모리 상주 파일명 인덱스.
  - 컴팩트 저장(offset 기반 단일 String + 병렬 vec)으로 수백만 경로도 가볍게.
  - 로컬은 전 드라이브 루트, 원격은 루트당 `find` 1회로 구축. 20k 단위로 부분 공개해
    인덱싱 중에도 검색 가능. 진행률은 `IndexProgressEvent`.
  - 캐시 키: `local|<root>` 또는 `ssh|<host_ip>|<user>|<root>`, TTL 신선도 체크,
    디스크 캐시 `<config>/duet/index/`.

### 11. 폴더 비교 · 3-way · 동기화

- **폴더 비교**(`file.compare`): 두 패널 폴더를 재귀 비교.
  - 분류: **왼쪽만 / 오른쪽만 / 왼쪽 최신 / 오른쪽 최신 / 다름 / 동일 / 읽기실패**.
    (읽기실패 항목은 머지/prune에서 제외 — "빈 폴더" 오해 방지)
  - **트리뷰 / 평면 리스트**, 상태별 필터(예: 동일 숨기기), **rename/move 감지**(내용으로
    LeftOnly+RightOnly 짝 매칭).
  - **Rules**: ignore glob(basename), mtime 허용오차(SSH↔로컬 초/밀리초 반올림 흡수).
  - **Verify**: 같은 호스트는 서버측 SHA256(다운로드 0), 교차 호스트는 바이트 비교(64MB
    상한)로 "동일" 오탐 검증.
  - **Export**: CSV / JSON.
  - **행별 적용**(`fs_apply_compare`): 행마다 방향(→ / ← / skip)을 골라 복사·덮어쓰기,
    양쪽 백업, undo 가능.
  - **양방향 머지**(`merge_bidir`): 한쪽에만 있는 파일을 서로 복사. 충돌/덮어쓰기/삭제는
    건드리지 않는 안전 모드.
- **3-way 비교**(`file.threeWay`): base 기준으로 LeftChanged/RightChanged/BothChanged,
  Added/Deleted, AddConflict/DeleteConflict 등을 분류. 비충돌 항목 자동 적용(변경 전파·
  삭제 전파·추가 단방향 복사), 충돌은 사용자 결정.
- **동기화**(`file.sync`): preview → plan → execute.
  - **단방향 미러**: src의 신규/최신 파일을 dst로. **Prune**(기본 OFF) 켜면 dst 단독
    파일을 휴지통으로(undo 가능, CTA가 danger 색). 원격 dst는 trash 용량 표시.
  - **양방향 머지**: 위 비교 기반 안전 머지.
  - dry-run 미리보기로 복사/삭제 대상·총량을 먼저 보여준다(최대 2000개 표시).

### 12. 압축 / 해제 / 아카이브 내부 탐색

- **압축**: `.zip`(deflate) / `.tar.gz`(flate2). 다중 선택 → CompressDialog 에서 이름·포맷.
- **해제**: zip / tar / tar.gz / gz. zip-slip(경로 탈출) 가드. 충돌 시 기존 대상 백업 후
  추출. **로컬은 Rust crate, 원격은 서버측 `unzip`/`tar` exec**(본인 PC 대역폭 0).
- **아카이브 내부 탐색(browse)**: 아카이브에 들어가면 임시 추출 후 일반 폴더처럼 탐색.
  - 로컬: `temp/duet-archive/<token>/`, 원격: `~/.duet-tmp/browse-<token>/`(서버측).
  - 정리: 로컬은 앱 시작 시, 원격은 연결 종료 시 회수.
- **편집 후 재압축(repack)**: 탐색 폴더에서 파일을 수정한 뒤 PathBar의 "Update archive"
  로 원본 아카이브에 다시 묶는다. 원본은 `.bak.<ts>` 백업, undo 가능. `.zip` / `.tar.gz`
  만 지원.

### 13. 일괄 이름변경 (Batch Rename)

다중 선택 후 `F2`. 규칙을 적용한 **미리보기**(`fs_batch_rename_preview`)에서 새 이름과
충돌을 먼저 확인하고 적용한다. 충돌이 있으면 all-or-nothing으로 거부(부분 변경 없음).
단일 저널 항목이라 `Ctrl+Z` 한 번에 모두 원복된다.

### 14. 커맨드 팔레트

`Ctrl+P`. fuzzy 매칭으로 다음을 한 곳에서 검색·실행한다.

- **빌트인 명령** 40여 종(탭/뷰/정렬/파일작업/비교/동기화/설정 등)
- **동적 항목**: 저장 호스트, 북마크, 호스트 즐겨찾기, 사용자 alias

fuzzy 점수는 부분수열 매칭 + 단어 경계·연속 매칭 보너스 + 길이 패널티. `↑/↓` 이동,
`Enter` 실행, `Esc` 닫기.

### 15. 사이드바 (Places · Volumes · 북마크 · 즐겨찾기 · 호스트)

`Ctrl+B` 토글. 섹션은 모두 접기 가능(상태 localStorage 영속).

- **Tasks** — 진행 중 작업 미니 진행률.
- **Places**(활성 패널의 시스템 기준) — 홈/데스크톱/문서/다운로드 등 표준 폴더 + 휴지통.
  클릭=활성 패널, `Cmd/Ctrl+클릭`=반대 패널.
- **Volumes** — 마운트된 드라이브/네트워크 공유. 우클릭으로 Eject(macOS `diskutil`,
  Windows Shell.Application, Linux `udisksctl`).
- **SSH Hosts** — `~/.ssh/config` 목록 + 연결 상태 점. 더블클릭으로 연결.
- **Saved Hosts** — 저장한 ad-hoc 프로필. 더블클릭으로 다이얼로그 prefill.
- **Bookmarks** — 로컬 경로 또는 SSH host+path. 드래그 재정렬, 우클릭 제거.
- **Host Favorites** — 호스트 별칭별로 묶인 자주 쓰는 원격 경로(`host-favorites.json`).
  그룹 접기/드래그 재정렬, 오프라인이면 자동 재연결 후 이동.
- **Host Groups** — 저장 호스트를 사이드바에서 묶는 UI 폴더(`host-groups.json`, 별칭만
  저장하는 메타데이터, 원본 삭제 시 자동 정리).
- **Recent** — 최근 방문 폴더(localStorage 영속).

### 16. 앱 런처

외부 앱을 등록해 빠르게 실행(AppLauncherStrip).

- 저장: `<config>/duet/app-launchers.json`. 항목 = id(uuid v7)/name/path/args/children.
  **1단계 폴더**(Dock 스타일)만 허용(폴더 안 폴더 금지, 단일 항목 폴더는 자동 해체).
- 조작: 추가/이름변경/인자설정/삭제/그룹화(두 앱을 폴더로)/폴더 안팎 이동/재정렬.
- 실행: 인자 없으면 `opener::open`(네이티브 "연결 프로그램"), 인자 있으면 argv 직접 exec
  (셸 미경유, 안전). macOS는 `open -n -a`(새 인스턴스).
- 아이콘: Windows는 `systemicons` 로 .exe 네이티브 아이콘 PNG 추출, macOS/Linux는
  모노그램 fallback.

### 17. 컨텍스트 메뉴 & OS 셸 통합

- **항목 우클릭**: 열기 / 반대 패널에서 열기 / Quick Look / Edit(원격: 다운로드→편집→
  저장 시 자동 업로드) / 경로 복사 / 북마크 / 이름변경 / 추출(아카이브) / Finder·탐색기에서
  보기 / 여기서 터미널 열기 / 삭제. 다중 선택은 압축·일괄 작업으로 조정.
- **빈 영역 우클릭**: 새 폴더 / 뷰 모드 / 정렬 / 숨김 토글 / 이 폴더 북마크.
- **Windows 셸 컨텍스트 메뉴**(Tier 2, IContextMenu COM): 로컬 단일 선택 시 duet 메뉴를
  먼저 띄우고, 네이티브 셸 항목(연결 프로그램·보내기·7-Zip 등 COM 핸들러)을 비동기로
  가져와 구분선 아래에 덧붙인다. 메뉴가 먼저 닫히면 세션을 정리해 orphan explorer.exe
  방지.
- **"Open in duet" 탐색기 등록**(Windows, 설정에서 토글): 폴더/드라이브 우클릭·배경에
  duet 열기 등록(HKCU, 관리자 불필요). 끄면 우리가 만든 키만 재귀 삭제(완전 가역).
- **터미널 열기**: macOS Terminal / Windows Terminal(`wt.exe`, 폴백 cmd) / Linux 다수
  터미널 자동 탐지.

---

## 키보드 단축키

모든 키는 **설정 → Keymap** 또는 `keymap.toml` 에서 재설정 가능(핫 리로드).
macOS에서는 `Ctrl` 이 자동으로 `Cmd` 로 매핑된다. 아래는 기본값과 command id.

| 분류 | 키 | command id | 동작 |
|---|---|---|---|
| **탭** | Ctrl+T | `tab.new` | 새 탭 |
| | Ctrl+W | `tab.close` | 탭 닫기 |
| | Ctrl+Tab | `tab.next` | 다음 탭 |
| | Ctrl+Shift+Tab | `tab.prev` | 이전 탭 |
| | — | `tab.moveToOther` | 활성 탭을 반대 패널로 |
| **이동** | Alt+← | `nav.back` | 뒤로(history) |
| | Alt+→ | `nav.forward` | 앞으로(history) |
| | Ctrl+L | `pane.editPath` | 주소창 직접 입력 |
| | Ctrl+U | `pane.swap` | 좌우 패널 swap |
| **뷰** | Ctrl+R | `view.refresh` | 새로고침 |
| | Ctrl+H | `view.toggleHidden` | 숨김 파일 토글 |
| | Ctrl+B | `view.toggleSidebar` | 사이드바 토글 |
| | F11 | `view.togglePreview` | 미리보기 패널 토글 |
| | Space | `view.quickLook` | Quick Look |
| | — | `view.details` / `view.grid` / `view.tiles` | 뷰 모드 |
| **정렬** | Ctrl+Shift+1..5 | `sort.byName/bySize/byMtime/byKind/byExt` | 정렬 키 |
| **파일** | F5 | `file.copy` | 복사(반대 패널로) |
| | F6 | `file.move` | 이동 |
| | F2 | `file.rename` | 이름변경(다중=일괄) |
| | F7 | `file.newFolder` | 새 폴더 |
| | Delete | `file.delete` | 휴지통 |
| | Shift+Delete | `file.deletePerm` | 영구 삭제(설정 ON 시) |
| | Ctrl+C / Ctrl+X / Ctrl+V | `file.clipCopy` / `file.clipCut` / `file.clipPaste` | 클립보드 복사/이동/붙여넣기 |
| | Ctrl+Shift+C | `file.copyPath` | 전체 경로 복사 |
| | Ctrl+Alt+C | `file.copyName` | 파일명 복사 |
| | Ctrl+Z | `edit.undo` | 되돌리기(undo) |
| **선택** | Ctrl/Cmd+Space | — | 선택 토글 |
| | (마우스) | — | 클릭=단일, Ctrl+클릭=토글, Shift+클릭=범위, 드래그=마키 |
| **검색/필터** | Ctrl+F | `filter.focus` | 빠른 필터(현재 패널) |
| | Ctrl+Shift+F | `search.global` | 글로벌 검색 |
| **북마크** | Ctrl+D | `bookmark.toggle` | 현재 위치 북마크 토글 |
| **작업** | — | `file.compare` / `file.threeWay` / `file.sync` | 비교 / 3-way / 동기화 |
| | — | `ssh.setupKeyAuth` | 패스워드리스 설정 |
| **기타** | Ctrl+P | `palette.open` | 커맨드 팔레트 |
| | Ctrl+, | `settings.open` | 설정 |
| | Ctrl+Q | `app.quit` | 종료(비-macOS) |

> ⚠️ **F5 = 복사**(TC 표준)다. 새로고침은 **Ctrl+R**.
> command id 가 있는 항목은 모두 재바인딩 가능. 기본 키가 없는 항목(`—`)은 팔레트나
> Keymap에서 키를 직접 지정해 쓴다.

---

## 설정

`Ctrl+,` → **General / Keymap / Aliases** 3개 섹션.

**General** (값은 `settings.toml` 에 저장):

| 키 | 기본값 | 설명 |
|---|---|---|
| `theme` | `system` | `system` / `light` / `dark` (→ `data-theme` CSS 토큰) |
| `default_sort` | `name` | 새 탭 정렬 키 (`name`/`size`/`mtime`/`kind`/`ext`) |
| `default_view` | `details` | 새 탭 뷰 (`details`/`grid`/`tiles`) |
| `show_hidden_default` | `false` | 새 탭에서 dotfile 표시 |
| `single_click_open` | `false` | 단일 클릭으로 열기 |
| `permanent_delete_enabled` | `false` | 영구 삭제 허용(켜도 `delete` 타이핑 확인) |
| `compare_ignore_globs` | `[]` | 폴더 비교 시 제외 패턴(basename glob) |
| `compare_mtime_tolerance_ms` | `0` | 비교 mtime 허용오차(ms) |

**Keymap** — command id별 바인딩 검색·재설정·기본값 복원.
**Aliases** — 사용자 명령(폴더로 Navigate / 호스트 Connect). 팔레트·사이드바에서 실행.

---

## 설정·데이터 파일 위치

`<config>` = Windows `%APPDATA%`, macOS `~/Library/Application Support`,
Linux `~/.config`. 모든 파일은 `<config>/duet/` 아래.

| 파일 | 용도 |
|---|---|
| `settings.toml` | 일반 설정 (위 표) |
| `keymap.toml` | 키 재설정 (`"키" = "command_id"`, 핫 리로드) — 예시 `config/keymap.toml.example` |
| `journal.jsonl` | undo 작업 로그 (append-only) |
| `bookmarks.json` | 북마크 |
| `host-favorites.json` | 호스트별 즐겨찾기 경로 |
| `host-groups.json` | 사이드바 호스트 그룹(별칭만) |
| `saved-hosts.json` | 저장 호스트(비번 제외) |
| `user-aliases.json` | 사용자 alias |
| `app-launchers.json` | 앱 런처 |
| `secrets.age` | (선택) age 암호화 SSH 비밀번호 vault |
| `index/` | 검색 인덱스 디스크 캐시 |
| `<remote-home>/.duet-trash/` | 원격 휴지통 |
| `<remote-home>/.duet-tmp/` | 원격 아카이브 임시 탐색 |

---

## 아키텍처 개요

```
┌───────────────────────────────────────────┐
│ Frontend (React + TypeScript + Zustand)   │  UI 렌더 · 입력 · 상태
└───────────────────────────────────────────┘
                ↕ IPC (Tauri commands + events)
┌───────────────────────────────────────────┐
│ Backend (Rust + Tauri)                    │
│   commands → services → core → fs → ssh   │
│                              └→ platform  │
└───────────────────────────────────────────┘
```

- **단방향 의존성**: `commands → services → core → fs → (ssh / platform)`. 역방향 금지.
- **IPC 경계 엄수**: 프론트엔드는 OS/파일시스템/SSH를 직접 호출하지 않고 **Tauri command
  로만** 의도를 표현. 실제 실행·검증은 백엔드.
- **타입 공유**: `specta` + `tauri-specta` 가 Rust 타입·command 시그니처를 TypeScript
  (`src/types/bindings.ts`)로 자동 생성.
- **이벤트**(백→프): `task:*` 진행/완료/오류, `fs:changed`, `connection:state`,
  `journal:changed`, `keymap:changed`, `compare:progress`, `index:progress`.

레이어별 책임:

| 레이어 | 책임 |
|---|---|
| `commands/` | Tauri command 진입점(얇게). 입력 검증, 결과를 IPC 타입으로 변환 |
| `services/` | TaskQueue, Journal, ConnectionPool, Supervisor, SecretVault, Settings, Keymap/FS watcher, FileIndex, PreviewStream, AppLaunchers |
| `core/` | 도메인 로직(OS/프로토콜 독립): copy 전략, compare, three_way, archive, ops, undo, search |
| `fs/` | `FileSystem` trait + `LocalFs` / `SshFs` |
| `ssh/` | russh 연결·config 파싱·인증·ProxyJump·remote exec |
| `platform/` | OS 분기: 휴지통, 볼륨, keychain, NFD 정규화, Windows 셸 메뉴/레지스트리 |

자세한 내용은 [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 빌드 · 테스트

```bash
# 개발
pnpm tauri dev

# 릴리즈 빌드
pnpm tauri build

# 린트 / 포맷
pnpm lint
pnpm format

# 테스트
cargo test --manifest-path src-tauri/Cargo.toml   # 백엔드 단위/통합
pnpm test                                          # 프론트엔드 (vitest)
./scripts/ssh-it.sh                                # SSH 통합 테스트 (docker)
```

SSH 통합 테스트는 기본 **256MB / 2000개**로 돌고, `DUET_SSH_IT_BYTES` /
`DUET_SSH_IT_COUNT` 로 **10GB / 1만개**까지 opt-in 한다.

> Rust는 `cargo fmt` + `cargo clippy -- -D warnings`, TS는 `eslint` + `prettier` 통과가
> 머지 조건. `fs`/`core`/`ssh` 레이어는 테스트 없이 머지 금지.

---

## 기술 스택

- **백엔드**: Rust + Tauri 2 + tokio + `russh`/`russh-sftp` + `russh-keys`
  - 휴지통 `trash`, 변경감지 `notify`, 디렉토리 워킹 `ignore`, 압축 `zip`/`tar`/`flate2`
  - 자격증명 `keyring`(OS keychain) + `age`(vault), 설정 `toml`/`serde`
  - 로깅 `tracing`, 에러 `thiserror`/`anyhow`
  - Windows 전용: `systemicons`(아이콘) · `winreg`(레지스트리) · `windows`(IContextMenu COM)
- **프론트엔드**: TypeScript + React 18 + Vite 6
  - UI: Tailwind CSS + Radix(Dialog) + lucide 아이콘, 가상 스크롤 `@tanstack/react-virtual`
  - 상태: Zustand, 미리보기 `pdfjs-dist` / `react-markdown` / `highlight.js`
- **IPC 타입**: `tauri-specta` 자동 생성
- **타겟 OS**: Windows 1순위, macOS / Linux 2순위

---

## 보안·안전 원칙

duet는 [`CLAUDE.md`](./CLAUDE.md)의 절대 규칙 위에서 동작한다. 핵심만:

1. **IPC 경계** — 프론트엔드는 OS/FS/SSH 직접 호출 금지, 모든 위험 작업은 백엔드 검증.
2. **영구 삭제 기본 OFF** — 삭제는 휴지통이 기본, 영구 삭제는 명시 활성화 + 단어 확인.
3. **모든 파괴적 작업 Undo 가능** — 저널 기록 + `Ctrl+Z`. "되돌릴 수 없는 작업"은 디자인
   실패.
4. **SSH 자격증명 비노출** — agent/IdentityFile 우선, 비번은 메모리에만(컴포넌트 local
   state→사용 직후 clear, 백엔드 zeroize), 로그 출력 금지, 디스크는 OS keychain 또는
   age vault.
5. **시스템 SSH 바이너리 미사용** — 모든 SSH는 `russh`(ProxyJump 포함).
6. **같은 호스트 복사는 절대 본인 PC 경유 금지** — TC의 핵심 문제, 반복 금지.
7. **직접 경로 문자열 조작 금지** — Rust는 `Path`/`PathBuf`, 경로 분기는 `platform/` 에서만.

---

## 문서 읽는 순서

새 작업 전에 **반드시** 이 순서로 읽는다(본인도, Claude Code도):

1. [`CLAUDE.md`](./CLAUDE.md) — 작업 규칙 (가장 짧고 가장 중요)
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 레이어 구조, IPC 경계, 모듈 책임
3. [`DESIGN.md`](./DESIGN.md) — UI/UX 원칙
4. [`ROADMAP.md`](./ROADMAP.md) — 단계별 목표와 완료 상태
5. `docs/specs/` — 기능별 설계 문서
