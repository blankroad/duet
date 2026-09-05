# duet UX 벤치마크 리뷰

> 2026-09-05 · 코드 리딩 기반 (main a1480b8) · 상용 파일 매니저 벤치마크

- **범위**: 프론트엔드 src/ 전반 + 백엔드 core/services/commands 의 동작 경로. 코드 리딩 기반 (앱 실행·실기 재현 없음).
- **벤치마크 대상**: Total Commander · Directory Opus · Double Commander · ForkLift 4 · Commander One · Path Finder · Finder · Windows Explorer · WinSCP · FileZilla · Cyberduck · Transmit 5 · Termius · VS Code (팔레트·키맵)
- **방법**: 영역별 심층 리뷰 5건을 병렬 수행 후 교차 정리. High 항목 15건은 리드가 코드로 직접 재검증 (✔ 표시).

## 한눈에

| 영역 | High | Med | Low | 합계 |
|---|---:|---:|---:|---:|
| 복사·이동·삭제·작업 큐 | 5 | 6 | 4 | 15 |
| 사이드바·북마크 | 4 | 7 | 6 | 17 |
| 탐색·탭·목록·키보드 | 5 | 9 | 6 | 20 |
| 설정·팔레트·검색·다이얼로그·알림 | 5 | 8 | 7 | 20 |
| 원격·SSH 연결 | 4 | 8 | 5 | 17 |
| **합계** | **23** | **38** | **28** | **89** |

핵심 결론:

1. **정책 정합성 버그 3건이 설정 문제보다 앞선다.** 같은 호스트 SSH 경로에서 Skip 이 무시되고(OP-04), 폴더 Replace 가 기존 폴더를 통째로 영구 삭제하며(OP-05), 같은 호스트 이동은 NotSupported 다(OP-03). Replace 를 기본값으로 열어 주기 전에 이 셋을 먼저 닫아야 한다.
2. **키보드 모델이 마우스 모델보다 한 세대 뒤져 있다.** Shift 범위 선택·Home/End·Ctrl+A 가 없고(NV-01), 상위로 가도 커서가 떠나온 폴더에 앉지 않으며(NV-03), macOS 기본 키가 시스템 예약 키를 밟는다(NV-02). 전부 프론트만으로 고칠 수 있다.
3. **"저장했는데 안 되는" 것들이 신뢰를 깎는다.** 저장 비번이 재시작 후 쓰이지 않고(SS-01), 예시 설정 파일의 키 17개가 존재하지 않으며(CF-01), 설정 화면 절반이 영어다(CF-03).
4. **잘 되어 있는 것도 많다.** 호스트키 검증, 자격증명 취급, 원격 휴지통 + Undo, 파일별 충돌 메타 비교, 새로고침 시 커서 유지, DialogShell 일관성은 상용 툴 동급 이상.

## 지적하신 두 가지, 확인 결과

### "복사/이동 모달에서 항상 Skip 이 기본, 설정 불가" — 사실

`CopyMoveConfirmDialog.tsx:49,52` 가 `"skip"` 을 하드코딩하고 열릴 때마다 리셋한다. `Settings` 에 충돌·확인 관련 필드는 없다. 백엔드 `ConflictPolicy` 의 기본은 `Replace` 라 두 층의 기본값도 다르다.

- 충돌이 없어도 확인창 → 진행 모달 → 완료 토스트 (OP-02).
- 더 큰 문제: same-host SSH 복사에선 Skip 을 골라도 복사되고 `.bak` 이 남는다 (OP-04). 폴더 Replace 는 병합이 아니라 기존 폴더 영구 삭제 (OP-05).
- 해법: `transfer_conflict_default` + 마지막 선택 기억 + 충돌 없을 때 확인 생략 (OP-01, OP-02). 단 OP-04/05 를 먼저.

### "즐겨찾기 탭이 좀 부실한 느낌" — 사실, 원인은 기능 수가 아님

레코드에 관리 동사가 없다: 이름변경·그룹·단축키·번호 전부 부재 (BM-02, BM-06, BM-11). 이름은 항상 basename 이라 세 서버의 `/var/log` 가 "log, log, log".

- 로컬 `Bookmark` 와 원격 `HostFavorite` 두 모델의 분열이 UI 로 샌다: 원격에선 ★ 이 채워지지 않고 누를 때마다 중복 추가 (BM-01), 아이콘·메뉴·드롭 규칙이 둘 (BM-05).
- 행이 키보드로 닿지 않고, Places 는 클릭인데 북마크는 더블클릭 (BM-03).
- 해법 순서: BM-01 → BM-03 → BM-02 → BM-06. 데이터 통합(BM-05)은 설계 승인 후.

## 이번에 고친 것 (20건)

리뷰 직후 같은 세션에서 손본 것들. 백엔드 340개·프론트 299개 테스트 통과.

| 항목 | 내용 | 상태 |
|---|---|---|
| BM-01 | 원격 폴더에서 ★ 이 절대 채워지지 않고, 누를 때마다 즐겨찾기가 하나씩 더 생긴다 — 백엔드 (호스트, 경로) dedup + PathBar ★ 이 원격에서도 상태 반영·토글 | 고침 |
| BM-02 | 북마크/즐겨찾기 이름을 바꿀 수 없다 (스펙에 있던 rename 이 빠짐) — bookmarks_rename / host_favorites_rename + 메뉴·F2 | 고침 |
| BM-03 | 북마크·즐겨찾기·호스트 행이 키보드로 닿지 않고, 열기 제스처가 섹션마다 다르다 — 네 종류 행 모두 한 번 클릭 + Tab 포커스 + Enter/⌘Enter/F2/Delete | 고침 |
| BM-05 | Bookmark vs HostFavorite 두 모델의 분열이 사용자 눈에 보인다 (Phase 3 "통합" 은 렌더링만) — 원격 즐겨찾기에 L/R 배지 추가. 데이터 통합은 후속 | 일부 |
| CF-01 | `settings.toml.example` 이 존재하지 않는 설정 17개를 약속하고, 경로·구조도 실제와 다름 — 예시 파일을 실제 스키마(평면 16키)로 다시 씀 + 저장 위치 명시 | 고침 |
| CF-03 | i18n — 설정 화면 4개 섹션이 통째로 영어 하드코딩, 그 외 30여 곳 산재 — 설정 General 섹션·목록 컬럼 헤더·스토어 토스트 i18n. Aliases/ExtIcons/OpenWith 섹션은 후속 | 일부 |
| CF-06 | 토스트가 DESIGN.md 와 어긋남 — 에러가 6초 후 사라지고, 성공 토스트가 잦으며, 행동할 수 없다 — 에러 토스트가 수동 닫기까지 유지 + 성공 토스트 절제. 액션 버튼(되돌리기/재시도)은 후속 | 일부 |
| NV-01 | 키보드 선택 모델이 사실상 없음 — Shift+↑↓, Home/End, PgUp/PgDn, Insert, Ctrl+A, 반전 전부 부재 — Shift 범위·Home/End·PgUp/Dn·Insert + Ctrl+A / Ctrl+Shift+A / Ctrl+Shift+I 커맨드 | 고침 |
| NV-03 | 상위로 갈 때 떠나온 폴더에 커서가 앉지 않음 + 뒤로/앞으로 시 커서·스크롤 미복원 — 상위 이동 시 떠나온 폴더에 커서. 뒤로/앞으로의 커서·스크롤 복원은 후속 | 일부 |
| NV-05 | 탭 전환 시 목록 갱신·감시자 재설정이 없음 → 낡은 목록 + 자동 새로고침 끊김 — 탭 전환 시 재로드 + pane_watch_set 갱신 | 고침 |
| NV-07 | 자연 정렬 없음(`file10` 이 `file2` 앞), 폴더 우선이 하드코딩 — 자연 정렬 적용. dirs_first 설정화는 후속 | 일부 |
| NV-19 | 키 표기/매칭 세부 — 문서의 `Esc` 는 매칭 불가, 레이아웃 의존 키, NumPad 미바인딩 — NumPad 를 e.code 로 구분해 바인딩 가능 + 패턴 선택/반전 alt 키. Esc 표기 문서는 후속 | 일부 |
| OP-01 | 충돌 정책 기본값이 Skip 고정 — 설정도, 마지막 선택 기억도 없음 — transfer_conflict_default + remember_conflict_choice 설정 추가, 다이얼로그가 그 값으로 시작 | 고침 |
| OP-02 | 충돌이 없어도 확인창 → 진행 모달 → 완료 토스트: 작은 복사 하나에 UI 3개 — confirm_transfer 설정(기본 conflicts_only), 진행 모달 700ms 유예, 완료 토스트 2초 이상만 | 고침 |
| OP-03 | 같은 SSH 호스트 안에서의 이동(F6 / 잘라내기→붙여넣기 / 드래그)이 NotSupported — 같은 연결이면 SFTP rename 으로 지원. 다른 연결·원격 cross-device 는 relay 대신 명시적 에러 | 고침 |
| OP-04 | same-host SSH 복사에서 Skip / Keep both 정책이 사실상 무시되고 .bak 이 남는다 — 항목별로 정책을 먼저 해석 — 건너뛰기는 제외, 둘 다 유지는 새 이름, 교체만 백업 | 고침 |
| OP-05 | 폴더 충돌에 "병합" 이 없음 — Skip 은 폴더 통째 건너뛰고, Replace 는 기존 폴더를 통째 영구 삭제 — 폴더 교체는 백업 보존 + journal 로 되돌릴 수 있게, 충돌 목록에 폴더 배지·안내. 탐색기식 병합은 후속 | 일부 |
| OP-11 | 휴지통 삭제 확인 다이얼로그를 끌 수 없음 — confirm_trash_delete 설정 (영구 삭제는 계속 항상 확인) | 고침 |
| SS-01 | 저장된 비밀번호가 앱 재시작 후 사실상 못 씀 — vault 상태를 부트스트랩에서 한 번도 안 읽음 — 부팅 시 vault 상태 refresh | 고침 |
| SS-02 | 연결 끊기(Disconnect) UI 가 전혀 없음 — 호스트 우클릭 '연결 끊기' + disconnectAlias | 고침 |

## 남은 것 — 먼저 손볼 것

### 정합성 버그 — 설정을 열어 주기 전에

OP-01 에서 Replace 를 기본값으로 고를 수 있게 하면 아래 셋의 피해 범위가 커진다. 셋 다 코드로 재검증했다.

| 항목 | 내용 | 심각도 | 규모 |
|---|---|---|---|
| OP-04 | same-host 복사에서 Skip/KeepBoth 무시 + .bak 잔류 | High | BE 소~중 |
| OP-05 | 폴더 충돌 병합 없음, Replace 가 기존 폴더 통째 영구삭제 | High | BE 중 + FE 소 |
| OP-03 | 같은 호스트 SSH 이동 NotSupported (확인창은 '즉시' 라고 안내) | High | BE 소~중 |

### 사용자가 지적한 두 가지

지적은 둘 다 사실이고, 각각 뒤에 더 큰 구조적 원인이 있다.

| 항목 | 내용 | 심각도 | 규모 |
|---|---|---|---|
| OP-01 | 충돌 기본값 설정 + 마지막 선택 기억 | High | settings + FE 소 |
| OP-02 | 충돌 없을 때 확인창·진행 모달·토스트 생략 | High | FE 소 + settings |
| BM-02 | 북마크 rename (F2·메뉴·인라인) | High | BE 소 + FE 소 |
| BM-01 | 원격 ★ 상태 반영 + 중복 추가 방지 | High | BE 소 + FE 소 |
| BM-03 | 사이드바 행 단일 클릭 통일 + 키보드 접근 | High | FE 중 |

### 프론트만으로 고칠 수 있는 큰 체감

백엔드 API 는 이미 있거나 필요 없다. 각각 하루 안쪽.

| 항목 | 내용 | 심각도 | 규모 |
|---|---|---|---|
| SS-01 | vault refresh 부트스트랩 (저장 비번이 재시작 후 동작) | High | FE 1줄 + 흐름 소 |
| SS-02 | Disconnect 메뉴/커맨드 | High | FE 소 |
| NV-05 | 탭 전환 시 새로고침 + 감시자 재설정 | High | FE 소 |
| NV-03 | 상위/뒤로 이동 시 커서 복원 | High | FE 소 |
| NV-01 | 키보드 선택 모델 (Shift 범위, Home/End, Ctrl+A, Insert) | High | FE 중 |
| NV-02 | macOS 기본 키맵 충돌 정리 | High | FE 중 |
| NV-07 | 자연 정렬 (Intl.Collator numeric) | Med | FE 1줄 |

### 첫인상·신뢰

기능이 아니라 문서와 문구의 문제. 비용 대비 효과가 크다.

| 항목 | 내용 | 심각도 | 규모 |
|---|---|---|---|
| CF-01 | settings.toml.example 을 실제 스키마로 | High | docs 소 |
| CF-03 | 설정 화면·목록 헤더·에러 라벨 i18n | High | FE 중 |
| CF-06 | 에러 토스트 수동 닫기 + 성공 토스트 절제 | High | FE 소 |
| CF-02 | 설정 커버리지 1차 (확인창·포맷·정렬·에디터) | High | settings + FE 중 |

## 영역별 발견 사항

### 복사·이동·삭제·작업 큐 (15건)

사용자가 지적한 "Skip 기본값" 은 사실이며 설정·기억 모두 없다. 그보다 앞서 손봐야 할 것은 같은 호스트 SSH 경로에서 정책 자체가 깨지는 3건이다 — Replace 를 기본값으로 열어 주기 전에 폴더 통째 삭제·Skip 무시부터 고쳐야 한다.

**잘 되어 있는 것 (상용 툴 동급 이상):**

- 파일별 충돌 목록의 새↔기존 크기·수정시각 비교, 최신 쪽 강조, 교체가 섞이면 주 버튼 danger + 푸터 집계 (`ConflictPerFileList.tsx`). Explorer 의 Compare info 와 동급.
- 진행률 정보 밀도 — 실제 파일명·n/전체·바이트·속도·ETA·총량 미상 시 indeterminate, plan 측정 400ms 시간상자 (`ops.rs:296-301`) 로 확인창이 늦지 않음.
- Undo/Redo + 히스토리 — 복사·이동·삭제·이름변경·일괄 이름변경·압축까지 저널링, 부분 실패·취소분도 기록. Finder/Explorer 보다 앞서고 DOpus undo list 와 동급.
- 잘라내기 흐림 표시 + Esc 취소 + OS 클립보드 미러 (`useCutNames.ts`, `fileActions.ts:187-215`).
- 삭제 안전망 — 휴지통 우선(원격 `~/.duet-trash` 포함), 영구 삭제는 설정 + 단어 타이핑을 백엔드가 강제 (`ops.rs:186-196`).
- 전송 경로를 말로 설명 ("서버 안에서 직접 복사 — 이 PC 를 거치지 않음") + 연결 끊김 시 `.part` 이어받기 자동 재시도 (`ops.rs:529-556`).
- 드롭 대상 범위 — 폴더 행·`..`·반대 패널·사이드바 위치/볼륨/북마크·북마크 추가 존·OS 파일 드롭. Path Finder/ForkLift 급.

#### OP-01 · 충돌 정책 기본값이 Skip 고정 — 설정도, 마지막 선택 기억도 없음

- **심각도**: High · **레이어**: settings + FE · ✔ 직접 검증 · **고침**: transfer_conflict_default + remember_conflict_choice 설정 추가, 다이얼로그가 그 값으로 시작
- **현재 동작**: `CopyMoveConfirmDialog.tsx:49` `useState("skip")`, `:52` 파일별 초기값도 전부 skip. 열릴 때마다 리셋. `services/settings.rs:24-63` `Settings` 에 충돌·확인 관련 필드 없음. 백엔드 `ConflictPolicy` 의 `#[default]` 는 `Replace` (`ops.rs:81-92`) — 두 층의 기본값이 다르다. DESIGN.md "기본 건너뛰기" 규칙을 충실히 구현한 결과라 규칙 자체가 원인.
- **상용 툴**: TC 는 Overwrite all / Skip all / Overwrite all older / Auto-rename 이 한 작업 안에서 유지. DOpus 는 Preferences 에서 기본 동작(Replace/Skip/Rename/Ask) + "Apply to all". ForkLift 4 도 Preferences 기본값 + Apply to all. Explorer 는 "Do this for all N conflicts".
- **문제**: 같은 폴더를 반복 덮어쓰는 사용자(서버에 빌드 결과물 올리기 등)는 매번 두 번 클릭. 개인화 불가는 파워유저 툴로서 결격.
- **제안**: `Settings.transfer_conflict_default: ask|skip|keepboth|replace` (기본 skip) + "세션 내 마지막 선택 기억" 옵션. replace 를 기본으로 골라도 주 버튼은 danger 유지. 단, OP-04·OP-05 를 먼저 고치지 않으면 Replace 기본은 위험.

#### OP-02 · 충돌이 없어도 확인창 → 진행 모달 → 완료 토스트: 작은 복사 하나에 UI 3개

- **심각도**: High · **레이어**: FE + settings · ✔ 직접 검증 · **고침**: confirm_transfer 설정(기본 conflicts_only), 진행 모달 700ms 유예, 완료 토스트 2초 이상만
- **현재 동작**: `fileActions.ts:392-402` plan 성공 시 충돌 0 이어도 무조건 confirm 오픈(OS 드롭도 동일 `useOsFileDrop.ts:39-40`). 확인 후 `App.tsx:1092-1096` 이 크기 무관하게 `ProgressModal` 을 띄우고, `ProgressModal.tsx:46-48` 는 task 가 사라지면 자동 닫힘 → 5KB 파일이면 모달이 깜빡. 그 뒤 `useTaskEvents.ts:66-74` 가 모든 완료 task 에 성공 토스트. DESIGN.md "50ms 이하 다이얼로그 없음 / 성공 알림은 큰 작업만" 과 충돌.
- **상용 툴**: TC 의 F5 확인창은 대상 경로·마스크를 편집할 수 있어 존재 이유가 있다(duet 것은 편집 불가). DOpus/ForkLift/Finder/Explorer 는 드래그·붙여넣기에 확인 없음, 진행창은 1-2초 넘어야 표시.
- **문제**: "복사는 즉시"(DESIGN 철학 3) 가 지켜지지 않는다. 편집 기능 없는 확인창은 Enter 반사 클릭을 습관화해, 정작 충돌 밴드가 있을 때도 그냥 Enter 를 치게 된다 — 안전장치가 무뎌진다.
- **제안**: (a) `confirm_transfer: always|conflicts_only|never` (기본 conflicts_only). (b) 진행 모달은 ~700ms 지연 또는 총량 임계 초과 시에만, 그 전에 끝나면 안 열기. (c) 완료 토스트는 모달을 띄웠던 작업에만.

#### OP-03 · 같은 SSH 호스트 안에서의 이동(F6 / 잘라내기→붙여넣기 / 드래그)이 NotSupported

- **심각도**: High · **레이어**: BE (+FE 임시 가드) · ✔ 직접 검증 · **고침**: 같은 연결이면 SFTP rename 으로 지원. 다른 연결·원격 cross-device 는 relay 대신 명시적 에러
- **현재 동작**: `ops.rs:687-690` `move_execute` 가 `strategy == SshSameHost` 면 무조건 `Err(NotSupported("same-host SSH move: MVP-3 v2 후속"))`. `copy_strategy.rs:33-41` 은 같은 host_ip 의 SSH 쌍을 — 같은 connection 이어도 — SshSameHost 로 판정하고 `commands/fs_ops.rs:773-830` 에 우회 분기가 없다. 확인창은 `is_same_fs=true` 라 "같은 볼륨 — 이름만 바뀜 (즉시)" 라고 안내한 뒤 task 가 실패하며 영어 토스트 `Operation failed — …`.
- **상용 툴**: WinSCP/Transmit/ForkLift/Cyberduck 모두 같은 서버 내 이동은 SFTP rename 한 번.
- **문제**: 원격 서버 정리(폴더 간 이동)라는 가장 흔한 SSH 작업이 안 되고, 확인창이 "즉시 이름만 바뀜" 이라고 약속하고 실패한다.
- **제안**: 같은 connection_id 면 `SshFs::rename`(백업 경로에서 이미 사용 중) 시도 → cross-device 면 same-host copy + trash 폴백. 프론트는 그 전까지 `strategy=ssh_same_host && kind=move` 면 사전 안내.

#### OP-04 · same-host SSH 복사에서 Skip / Keep both 정책이 사실상 무시되고 .bak 이 남는다

- **심각도**: High · **레이어**: BE · ✔ 직접 검증 · **고침**: 항목별로 정책을 먼저 해석 — 건너뛰기는 제외, 둘 다 유지는 새 이름, 교체만 백업
- **현재 동작**: `ops.rs:3534-3552` 백업 루프가 정책과 무관하게 충돌 대상을 전부 `.bak.<ts>` 로 rename 한 뒤, `:3582-3595` rsync `--ignore-existing` / `cp -n` 은 이미 비워진 경로를 만나 그냥 복사 → Skip 을 골라도 새 파일이 들어가고 `.bak` 이 폴더에 보인다. KeepBoth 는 주석대로 "미지원 → 덮어쓰기 폴백" (`:3579-3581`). Replace 는 백업을 journal 에 넣어 undo 가능 — relay 경로(백업 영구삭제·undo 불가)와 정반대. 다이얼로그 문구 셋 다 same-host 에선 틀림.
- **상용 툴**: 정책 선택이 전송 경로에 따라 달라지는 툴은 없다.
- **문제**: "건너뛰기" 로 보호하려던 서버 파일이 교체된다(백업은 남지만 사용자는 모른다). 앱의 핵심 가치 경로에서 정책이 깨진다.
- **제안**: 백업 루프 전에 정책별 필터 — Skip 은 충돌 항목을 인자에서 제외, KeepBoth 는 `dedup_dst_name` 으로 대상 이름을 바꿔 개별 실행, Replace 는 relay 와 동일하게 성공 시 백업 제거(또는 relay 도 .bak 보존으로 통일하고 문구 수정). same-host Skip/KeepBoth 테스트 추가.

#### OP-05 · 폴더 충돌에 "병합" 이 없음 — Skip 은 폴더 통째 건너뛰고, Replace 는 기존 폴더를 통째 영구 삭제

- **심각도**: High · **레이어**: BE + FE · ✔ 직접 검증 · **일부 고침**: 폴더 교체는 백업 보존 + journal 로 되돌릴 수 있게, 충돌 목록에 폴더 배지·안내. 탐색기식 병합은 후속
- **현재 동작**: `ops.rs:316-333` plan 은 최상위 이름 존재만 본다. `Conflict` 에 `is_dir` 없음. 실행 `:509-524` 는 파일/폴더 구분 없이 정책 적용: Replace 는 기존 폴더 전체를 백업으로 rename → 새 폴더 복사 → `:565-571` 백업 영구 삭제(`dst_fs.remove`). 즉 `docs/` 위에 `docs/` 를 Replace 하면 기존에만 있던 파일들이 휴지통도 거치지 않고 사라진다. `ConflictPerFileList.tsx:52-55` 는 모든 충돌을 파일 아이콘으로 그려 폴더인지 알 수 없다.
- **상용 툴**: Explorer 는 폴더는 항상 병합 후 내부 파일별 질문. Finder 는 Merge / Replace / Stop. TC/DOpus/Double Commander 모두 병합 + 내부 파일별 overwrite 질문.
- **문제**: 파일 매니저 사용자의 기대(폴더=병합)와 정반대이고 결과가 영구·비가역. CLAUDE.md §4 예외는 "파일 덮어쓰기" 를 승인한 것이지 폴더 소실까지 의도했다고 보기 어렵다.
- **제안**: (a) `Conflict.is_dir` + 프론트 폴더 배지. (b) 폴더 충돌 기본 = 병합(내부 파일에만 정책 적용 — `copy_tree` 에 파일 단위 콜백이 이미 있음). (c) "폴더 통째 교체" 는 별도 옵션 + danger 문구 "기존 폴더의 다른 파일도 사라짐".

#### OP-06 · 오류 1건이면 전체 중단 — 재시도 / 건너뛰기 / 일시정지 없음

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: `task_queue.rs:95-181` 는 enqueue/cancel/list 만, pause/resume 없음. 항목 오류 시 `ops.rs:589-594` `outcome = Err; break` — 뒤 항목은 시도조차 안 함(부분 진행분 journal 은 기록). 실패는 하드코딩 영어 토스트 후 task 제거 — 실패 목록/재시도 없음. 연결 끊김만 3초 후 1회 자동 재시도(이건 좋음).
- **상용 툴**: TC 오류 시 Retry / Skip / Skip all / Cancel. DOpus 큐 pause·skip·retry. ForkLift·Transmit 활동창에 실패 항목 잔류 + Retry. Explorer Try again / Skip / Cancel.
- **문제**: 1,000개 중 3번째가 권한 오류면 997개가 안 간다. 원격 대용량 전송 중 대역폭 양보(일시정지) 불가.
- **제안**: 오류 수집 후 계속 + 완료 시 실패 목록(실패분만 재plan 하는 재시도). `PauseGate`(tokio Notify) 를 chunk/항목 경계에서 체크하는 `task_pause/resume`. 실패 task 는 TasksBar 에 잔류.

#### OP-07 · 건너뛴 항목 수가 어디에도 보고되지 않음 — Skip 기본값과 결합해 조용한 누락

- **심각도**: Med · **레이어**: BE(event) + FE
- **현재 동작**: `ops.rs:598-603` `skipped` 를 세지만 journal `count` 는 복사분만. 완료 토스트는 `Completed: {{title}}`, title 은 백엔드 영어 `"Copying a and 4 more → /dst"` (`fs_ops.rs:1911-1931`). 전부 skip 이어도 빈 journal 로 "성공".
- **상용 툴**: TC/DOpus 작업 로그·요약, ForkLift/Transmit 활동창에 skipped/failed 카운트.
- **문제**: "복사됐다" 토스트를 보고도 실제로는 절반이 안 갔을 수 있다.
- **제안**: `Completed { journal_id, copied, skipped }` 로 이벤트 확장 → "3개 복사 · 2개 건너뜀(이미 있음)". title 은 kind+count+dst 를 구조화해 프론트가 조립(i18n).

#### OP-08 · "더 최신만 / 크기 다르면 덮어쓰기" 정책 없음 — per-file 수동 클릭이 유일한 길

- **심각도**: Med · **레이어**: FE → BE
- **현재 동작**: 정책 3종뿐 (`ops.rs:81-92`). per-file 목록은 메타를 비교하고 최신 쪽을 진하게 표시하지만 "일괄 설정" 은 skip/keepboth/replace 뿐이라 행마다 클릭. 상단 밴드에서는 메타 비교가 보이지 않는다.
- **상용 툴**: TC Overwrite all older / all different size, DOpus Replace if newer / Skip identical, WinSCP Newer only, Explorer Compare info 체크박스 일괄.
- **문제**: 동기화성 복사(변경분만)를 매번 손으로 골라야 한다.
- **제안**: 단기(FE): per-file 일괄 설정에 "새 파일이 더 최신인 것만 교체" 버튼(메타는 plan 에 이미 있음). 중기(BE): `ConflictPolicy::ReplaceIfNewer` (same-host 는 rsync `--update`).

#### OP-09 · 작업 큐 가시성·제어 부족 — 대기/실행 구분 없음, 완료 이력 없음, 전부 직렬

- **심각도**: Med · **레이어**: BE + FE + settings
- **현재 동작**: `TasksBar.tsx` 는 1개면 한 줄, 2개+ 면 드롭다운; `selectActive` 가 queued/running 을 섞어 표시. 큐는 host_key 별 FIFO 워커 1개(`task_queue.rs:121-129`) 이고 로컬↔로컬·relay 는 모두 `HostKey::Local` (`fs_ops.rs:1898-1909`) → 서로 다른 호스트로의 relay 전송도 한 줄로 직렬. 완료 즉시 store 제거, 이력 없음.
- **상용 툴**: DOpus 큐(unqueue/재정렬/동시 실행 설정), ForkLift Activity 창(완료·실패 이력), Transmit 전송 목록.
- **문제**: 서버 A 로 올리는 동안 서버 B 에서 내려받기가 대기한다. 지난 작업의 결과를 다시 볼 수 없다.
- **제안**: HostKey 를 `(src_source, dst_source)` 로 세분하거나 `max_concurrent_transfers` 설정. TasksBar 에 "대기 중" 배지, 완료/실패 이력 패널(HistoryDialog 와 통합 가능).

#### OP-10 · 드래그 수식키가 macOS 관례와 어긋나고, 드래그 중 복사/이동 표시가 없음

- **심각도**: Med · **레이어**: FE · ✔ 직접 검증
- **현재 동작**: `useEntryDrag.ts:51` `wantMove = e.ctrlKey || e.shiftKey` — `metaKey` 없음. 키보드 쪽은 `keyEvent.ts:16` 에서 ⌘→Ctrl 로 정규화하는데 드래그만 예외라 macOS 에서 ⌘-드래그가 이동이 안 되고, Ctrl+마우스다운은 WebKit 우클릭 제스처와 겹친다. `DragGhost.tsx` 는 파일명만 — 복사인지 이동인지 표시 없음. 같은 볼륨 내 드래그도 기본 복사.
- **상용 툴**: Finder 같은 볼륨 이동/⌥ 복사/⌘ 이동, 커서에 + 배지. Explorer 같은 볼륨 이동/다른 볼륨 복사, Ctrl=복사 Shift=이동, "Copy to / Move to" 라벨. TC 드래그=복사, Shift=이동.
- **문제**: 맥 사용자는 이동 드래그 방법이 없다. 놓기 전에 결과를 예측할 수 없다.
- **제안**: `e.metaKey` 포함 + 고스트에 "복사 → 대상" / "이동 → 대상" 라벨. 설정 `drag_same_source_default: copy|move`.

#### OP-11 · 휴지통 삭제 확인 다이얼로그를 끌 수 없음

- **심각도**: Med · **레이어**: settings + FE · **고침**: confirm_trash_delete 설정 (영구 삭제는 계속 항상 확인)
- **현재 동작**: `fileActions.ts:579-584` → `delete-confirm` 항상. `settings.rs` 에 관련 필드 없음.
- **상용 툴**: Finder ⌘⌫ 즉시 휴지통(확인 없음), Explorer 기본 확인 없음(옵션), ForkLift 확인 없음, TC 는 확인(옵션 off 가능).
- **문제**: DESIGN "안전한 작업은 무마찰" — 휴지통은 Ctrl+Z 로 복원되므로 확인은 선택이어야 한다.
- **제안**: `confirm_trash_delete: bool` (기본 true). 원격 휴지통은 별도 기본값 유지 가능.

#### OP-12 · 같은 폴더에 붙여넣기(Ctrl+C→Ctrl+V 제자리) 하면 "할 일 없음"

- **심각도**: Low · **레이어**: FE
- **현재 동작**: `clipPaste` (`fileActions.ts:233-240`) 는 move 만 제자리 no-op 처리. copy 는 전부 충돌 → 기본 skip → Enter 치면 `toast.nothingToDo`. 사본을 만들려면 "둘 다 유지" 를 골라야 한다.
- **상용 툴**: Finder "name copy", Explorer "name - Copy" 자동 생성. DOpus Duplicate.
- **문제**: 복제라는 흔한 의도가 두 번의 선택을 요구한다.
- **제안**: 모든 대상이 dst 안에 있고 mode=copy 면 정책 초기값을 keepboth 로(또는 확인 없이 바로 실행하는 "복제" 커맨드).

#### OP-13 · 파일별 결정이 정책별 여러 task·여러 journal 엔트리로 쪼개짐

- **심각도**: Low · **레이어**: BE + FE
- **현재 동작**: `App.tsx:1120-1196` 은 decisions 를 정책별 그룹으로 나눠 각각 plan+execute — 최대 3 task, 3 journal. 진행 모달은 가장 큰 그룹만, Ctrl+Z 한 번은 마지막 그룹만 되돌린다.
- **상용 툴**: 한 작업 = 한 undo 단위(DOpus undo list, Finder 단일 undo).
- **문제**: 되돌리기 단위가 사용자의 작업 단위와 다르다.
- **제안**: `fs_copy_execute(plan, policy, overrides: Option<HashMap<String, ConflictPolicy>>)` 로 백엔드가 항목별 정책 적용 → 단일 task/journal.

#### OP-14 · 이름변경 세부 — 충돌 시 원시 에러, Tab 순회 없음, 일괄 이름변경은 Enter 로 실행 안 됨

- **심각도**: Low · **레이어**: FE
- **현재 동작**: 인라인 rename 은 확장자 제외 선택(좋음). 대상 존재 시 백엔드 `"target exists: /full/path"` 를 그대로 토스트. `BatchRenameDialog.tsx:120-122` 는 Ctrl/⌘+Enter 만 제출, 주 버튼에 `hint="enter"` 없음 — DialogShell 규칙과 불일치.
- **상용 툴**: Explorer F2 후 Tab 으로 다음 파일, 충돌 시 인라인 경고. TC 다중 rename 은 Enter.
- **문제**: 연속 이름변경이 끊기고, 실패가 사후 토스트로만 온다.
- **제안**: rename 충돌은 입력창 아래 인라인 경고(패널 entries 로 사전 검사) + Tab 순회. batch rename 에 Enter 제출.

#### OP-15 · 취소 후 부분 결과 안내 없음

- **심각도**: Low · **레이어**: BE(event) + FE
- **현재 동작**: 취소 시 부분 복사분이 journal 에 기록되고 undo 가능하지만 토스트는 `"Cancelled: {{title}}"` 뿐.
- **상용 툴**: TC 는 취소 시 진행분 유지 안내, DOpus 로그.
- **문제**: 이미 넘어간 N개가 남아 있는지, 되돌릴 수 있는지 알 수 없다.
- **제안**: Cancelled 이벤트에 진행 카운트 → "12개는 이미 복사됨 — Ctrl+Z 로 되돌리기".

### 사이드바·북마크 (17건)

"부실한 느낌" 의 실체는 기능 수가 아니다. (1) 북마크 레코드에 이름변경·그룹·단축키 같은 관리 동사가 하나도 없고, (2) 로컬 Bookmark / 원격 HostFavorite 두 모델의 분열이 별 아이콘·중복 메뉴·드롭 거부·하이라이트 누락으로 새어 나오며, (3) 행이 키보드로 닿지 않고 열기 제스처가 섹션마다 다르다.

**잘 되어 있는 것 (상용 툴 동급 이상):**

- 호스트 인식 즐겨찾기 — `(host_alias, path)` 로 저장돼 재접속에 안전하고, 끊긴 상태에서 열면 접속 후 그 경로로 복귀 (`App.tsx:1416-1443`). Cyberduck/Transmit 의 핵심 모델.
- 현재 위치 하이라이트 + L/R 배지 (`Sidebar.tsx:271-312`) — Finder 는 한 창의 위치만 표시하니 듀얼 패널 맥락에선 더 낫다.
- ⌘/Ctrl-클릭 = 반대 패널이 모든 행에 일관 적용. TC 핫리스트엔 없는 듀얼 패널 affordance.
- 사이드바 행으로 파일 드롭 = 복사/이동, 빈 곳 = 북마크 추가, OS 드롭 수용, accent 링 프리뷰 (`dropTarget.ts:48-69`).
- 이름 필터 + 매치 강조 + 태그 칩 OR 필터. Termius/Cyberduck 의 검색·라벨 패턴.
- 별명(nickname) 이 사이드바·PathBar·상태바로 전파 (`hostLabel.ts`), 연결 상태를 색이 아닌 모양으로 (`StateDot`).

#### BM-01 · 원격 폴더에서 ★ 이 절대 채워지지 않고, 누를 때마다 즐겨찾기가 하나씩 더 생긴다

- **심각도**: High · **레이어**: BE + FE · **고침**: 백엔드 (호스트, 경로) dedup + PathBar ★ 이 원격에서도 상태 반영·토글
- **현재 동작**: `PathBar.tsx:147-152` 는 로컬 `useBookmarks` 만 보고 `bookmarked` 를 계산. SSH 북마크는 부팅 시 호스트 즐겨찾기로 이관돼 사라지므로(`bookmarks.ts:30-47`) 원격에선 항상 false → 별이 비어 있고 툴팁도 늘 "Bookmark this folder". 별/`Ctrl+D`/드롭다운/컨텍스트 메뉴 모두 `addHostFavorite` → 백엔드 `HostFavoritesStore::add` 는 무조건 push (`host_favorites.rs:54-77`). 중복 검사는 이관 코드에만 있다.
- **상용 툴**: ForkLift `Cmd+D` 는 토글(있으면 제거), Explorer Pin/Unpin 토글, Cyberduck 은 같은 host+path 면 기존 항목 편집으로 유도.
- **문제**: 원격에서 `Ctrl+D` 두 번 = 즐겨찾기 2개. 같은 키가 소스에 따라 다르게 동작(로컬 토글 / 원격 추가 전용).
- **제안**: `HostFavoritesStore::add` 에 `(host_alias, path)` dedup + 프론트 `findHostFavoriteId` 를 `liveByAlias` 로 계산해 별 상태/토글에 사용.

#### BM-02 · 북마크/즐겨찾기 이름을 바꿀 수 없다 (스펙에 있던 rename 이 빠짐)

- **심각도**: High · **레이어**: BE + FE · ✔ 직접 검증 · **고침**: bookmarks_rename / host_favorites_rename + 메뉴·F2
- **현재 동작**: `BookmarkItem` 메뉴 = Open / Open in other pane / Copy path / Edit tags / Remove (`Sidebar.tsx:1135-1163`), `FavoriteItem` 도 동일. 백엔드는 list/add/remove/reorder 4개뿐(`stores/bookmarks.ts`, `bookmarks.rs`, `host_favorites.rs`). MVP-6 설계서 193행의 `rename(id, new_name)` 은 미구현. 이름은 항상 basename 자동, 추가 시 프롬프트 없음. 호스트는 별명 편집이 되는데 북마크만 안 된다.
- **상용 툴**: TC "Add current dir…" 는 제목 프롬프트, DOpus 이름·alias 편집, Cyberduck/Transmit nickname, ForkLift 인라인 rename.
- **문제**: 세 호스트의 `/var/log` 를 즐겨찾기하면 "log, log, log". 바꾸려면 삭제 후 재추가 — 태그·순서도 잃는다. "관리할 수 있는 것" 이 없어 목록이 얕아 보이는 가장 직접적 원인.
- **제안**: `bookmarks_rename` / `host_favorites_rename` (또는 통합 `update`) + 메뉴 "Rename…" + 행 포커스 시 F2 + 더블클릭 인라인 편집. `Shift+Ctrl+D` = 이름 묻고 북마크.

#### BM-03 · 북마크·즐겨찾기·호스트 행이 키보드로 닿지 않고, 열기 제스처가 섹션마다 다르다

- **심각도**: High · **레이어**: FE · **고침**: 네 종류 행 모두 한 번 클릭 + Tab 포커스 + Enter/⌘Enter/F2/Delete
- **현재 동작**: Places/Trash/Recent/This PC 는 `<button onClick>` — 한 번 클릭, Tab 포커스 가능. 반면 `BookmarkItem`(`Sidebar.tsx:1164-1178`), `FavoriteItem`, `SavedHostItem`, `HostItem` 은 `<div onDoubleClick>` — 한 번 클릭은 무반응, `tabIndex`/`role`/`onKeyDown` 이 파일 전체에 하나도 없음. ⌘-클릭도 `onDoubleClick` 안에서만 판정되므로 북마크는 ⌘+더블클릭이 필요. `VolumeItem` 은 `<div onClick>` 으로 또 다르다.
- **상용 툴**: Finder/ForkLift/Path Finder/Dolphin 사이드바 모두 단일 클릭, 방향키+Enter 가능. TC 핫리스트는 키보드 메뉴.
- **문제**: DESIGN "키보드 1급 + 마우스 1급" 위반. 같은 사이드바 안에서 Places 는 클릭, 북마크는 더블클릭 — 매번 "왜 안 열리지".
- **제안**: 모든 행을 단일 클릭 열기로 통일(더블클릭은 "새 탭" 으로 재활용), `role="option"` + roving `tabIndex` + ↑↓/Enter/⌘+Enter/F2/Delete. `useReorderable` 는 임계값 미만이면 click 을 통과시키므로 충돌 없음.

#### BM-04 · `Ctrl+J` 점퍼의 원격 항목은 재접속하면 죽고, 세션마다 중복 누적된다

- **심각도**: High · **레이어**: BE + FE
- **현재 동작**: `frecency.rs:29-36` `loc_key` 가 SSH 를 `ssh:{connection_id}` 로 키잉하는데 connection_id 는 접속마다 새 uuid (`connection.rs:126`). 재접속마다 같은 경로가 새 항목으로 쌓이고(상한 1000) 이전 항목은 죽은 id 로 남는다. `FrecencyJumper.tsx:63-66` 는 그 id 로 navigate → `toast.cannotOpen`. 스펙(`frecency-jump.md:40`)은 `ssh{host_ip,user}` 키를 의도. Recent 는 `(alias, path)` 로 저장하는 올바른 패턴이 이미 있다(`recents.ts:8-12`).
- **상용 툴**: zoxide/ForkLift Recent 는 안정 키. Transmit/Cyberduck 히스토리는 호스트+경로.
- **문제**: 원격 작업이 많을수록 점퍼가 쓰레기로 차고, 골라도 "cannot open". 기능의 핵심 가치가 원격에서 무효.
- **제안**: `FrecencyEntry.host_alias` 추가, 키를 `ssh:{alias}` 로, 로드 시 구형 항목 폐기. jump 는 alias 있으면 `onOpenHostPath` 경유(자동 접속 포함).

#### BM-05 · Bookmark vs HostFavorite 두 모델의 분열이 사용자 눈에 보인다 (Phase 3 "통합" 은 렌더링만)

- **심각도**: Med · **레이어**: BE + FE · **일부 고침**: 원격 즐겨찾기에 L/R 배지 추가. 데이터 통합은 후속
- **현재 동작**: 스펙은 단일 레코드였으나 `BookmarksSection` 이 두 store 를 Local/Remote 서브라벨로 나란히 그릴 뿐(`Sidebar.tsx:1003-1113`). 새는 지점: 아이콘 Star vs Heart; 원격 파일 우클릭에 "Add to bookmarks" 와 "Add to host favorites" 가 둘 다 나오는데 전자도 결국 favorites 로 감(`entryMenu.tsx:402-418`); 팔레트 라벨 형식 상이; 원격 파일을 북마크 존에 드롭하면 "Bookmarks are local-only" 토스트(`useEntryDrag.ts:151-171`); `FavoriteItem` 엔 현재 위치 하이라이트·L/R 배지·`dropAttrs` 가 없음; 원격 그룹은 alias 알파벳순 고정; 이관·성공 토스트 영문 하드코딩.
- **상용 툴**: Cyberduck/Transmit 은 북마크 = host + path + name 하나. DOpus 는 로컬/원격 경로를 같은 목록에.
- **문제**: 같은 개념이 두 이름·두 아이콘·두 메뉴·두 규칙으로 보여 "정리가 안 된" 인상, 원격 즐겨찾기는 로컬보다 기능이 적다.
- **제안**: 즉시: `FavoriteItem` 에 `usePaneAt`/`dropAttrs`, 중복 메뉴 제거. 정공: 단일 `bookmarks.json` `{id, name, host_alias?, path, tags, order}` + 이관, store·컴포넌트·메뉴 하나로.

#### BM-06 · 북마크에 단축키/번호를 줄 수 없다 — `Ctrl+1..9` / `Alt+1..9` 가 비어 있음

- **심각도**: Med · **레이어**: FE · ✔ 직접 검증
- **현재 동작**: 북마크 builtin 은 `bookmark.toggle`(Ctrl+D) 하나(`commands.ts:311-316`). 개별 북마크는 `bookmark.open:<uuid>` 동적 커맨드라 keymap 에 매려면 uuid 를 알아야 한다. `Ctrl+1..9`/`Alt+1..9` 는 어디에도 바인딩 없음.
- **상용 툴**: DOpus Go FAVORITE=N 핫키, TC 핫리스트 항목별 단축키, ForkLift `Cmd+Shift+숫자`.
- **문제**: 가장 자주 가는 3~5곳을 한 키로 못 간다.
- **제안**: `bookmark.goto1..9` builtin(사이드바 순서의 N번째, 기본 `Alt+1..9`) + 행 오른쪽 번호 배지. 후속으로 레코드 `hotkey` 필드.

#### BM-07 · TC 식 즐겨찾기 팝업은 있지만 마우스로만 열리고, 원격 매칭이 문자열 파싱에 의존

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `PathBar.tsx:162-208` `openFavorites` — 아이콘 클릭으로만, 커맨드 없음. 원격은 `connection_id.split(":")[0]` 로 alias 추출 — `alias:uuid` 포맷에 암묵 의존. 선택은 같은 패널로만.
- **상용 툴**: TC `Ctrl+D` 팝업(키보드 탐색, 서브메뉴), DOpus Favorites 메뉴.
- **문제**: DESIGN "팔레트로 모든 명령 접근" 을 이 팝업만 어긴다.
- **제안**: `bookmark.showMenu` 커맨드(예: `Alt+D`), 항목별 서브메뉴 Open / Other pane / New tab, alias 는 `liveByAlias` 로.

#### BM-08 · 북마크 행이 이름만 보여줘 같은 이름을 구분할 수 없고, 필터도 이름만 본다

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `BookmarkItem` = Star + 이름 + 태그, 경로는 `title` 툴팁뿐. 필터는 `matchesQuery(b.name, q)` — 경로·호스트 미매칭. 호스트 필터도 별명/alias 만, `user@host` 는 안 잡힌다.
- **상용 툴**: Transmit/Cyberduck 은 nickname + server/path 두 줄, Cyberduck 검색은 nickname·host·path 모두.
- **문제**: BM-02 와 결합해 "log / log / log" 가 구분 불가.
- **제안**: 이름 ≠ basename 이거나 중복일 때만 muted 경로 서브타이틀(`shortenPath`). 필터를 경로·alias·`user@host` 로 확장.

#### BM-09 · 끊긴 호스트의 즐겨찾기를 열면 패널 지정이 유실되고 다이얼로그를 한 번 더 클릭해야 한다

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `onOpenHostPath` 가 비연결이면 `pendingNav = { alias, path }` 에 pane 을 넣지 않고(`App.tsx:1439`) `ConnectionDialog` 로 → 자동 접속 없이 대상 패널을 `"left"` 로 초기화(`ConnectionDialog.tsx:49`). `FavoriteGroup` 헤더 상태 점은 색만 다른 원 — DESIGN "연결 상태는 모양으로" 와 어긋남.
- **상용 툴**: Cyberduck/Transmit 북마크 더블클릭 = 즉시 접속 + 경로(비번은 keychain), Termius 즉시 접속.
- **문제**: ⌘+더블클릭으로 오른쪽에 열려던 의도가 사라져 왼쪽에 열린다. 키/vault 인증 호스트인데도 매번 다이얼로그.
- **제안**: `pendingNav.pane` + 다이얼로그 target prefill; 키/agent/vault 로 인증 가능하면 다이얼로그 없이 시도, 실패 시에만 다이얼로그; 헤더에 `StateDot` 재사용.

#### BM-10 · 추가가 조용히 실패·무시되고, 추가 후 어디 생겼는지 피드백이 없다

- **심각도**: Med · **레이어**: FE
- **현재 동작**: 로컬 `addBookmark` 실패 시 토스트 없음(`bookmarks.ts:49-59`), 이미 있으면 무언 반환, 섹션 `+` 성공 시에도 토스트/스크롤/강조 없음. 섹션이 접혀 있으면(영속) 새 행이 안 보인다. 빈 상태 문구는 Ctrl+D·드래그·★ 을 언급하지 않는다.
- **상용 툴**: Finder 는 삽입 애니메이션, ForkLift 별 채움 + 즉시 표시.
- **문제**: "눌렀는데 뭔가 됐나?" — 특히 접힌 섹션·원격 이관 후.
- **제안**: 추가 후 섹션 자동 펼침 + 새 행 잠깐 강조(≤200ms), 이미 존재하면 i18n 토스트, 빈 상태에 힌트.

#### BM-11 · 그룹/폴더/중첩이 없고, 유일한 대체재인 태그는 편집 UX 가 텍스트 프롬프트

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: 호스트 그룹은 저장 호스트에만(`Sidebar.tsx:722-790`), config 호스트 메뉴엔 그룹 항목 없음. 북마크엔 그룹 없음. 태그는 쉼표 문자열 프롬프트(`tags.ts:55-69`), 자동완성·태그 이름변경/삭제 없음. TagBar 는 Places 위에 있지만 Places/Recent 엔 적용 안 됨.
- **상용 툴**: TC 핫리스트 서브메뉴, DOpus 폴더 중첩, Transmit 폴더, Termius 그룹+태그, Dolphin 카테고리.
- **문제**: 호스트 10개·북마크 20개를 넘기면 평면 목록. prod/staging/dev 구조를 못 만든다.
- **제안**: (A) 저비용: 태그 1급 — 칩 피커+자동완성, `tag_rename`, 태그별 묶어 보기. (B) 정공: 통합 레코드에 `group` + 접힘 그룹, `useReorderable.onMerge` 로 드래그해 넣기.

#### BM-12 · 좌·우 패널 세트를 하나로 저장하는 "워크플로 북마크" 가 없다

- **심각도**: Low · **레이어**: BE + FE
- **현재 동작**: `Bookmark` 는 `Location` 하나(`bookmarks.rs:16-23`). 동기화 브라우징과 user alias 도 단일 패널.
- **상용 툴**: Double Commander/TC 양쪽 패널 저장, Transmit 즐겨찾기 = 로컬+원격 경로 쌍, DOpus 레이아웃.
- **문제**: 배포 작업(로컬 `dist` ↔ 서버 `/var/www`)처럼 항상 같은 쌍을 여는 사용자가 매번 두 번 이동.
- **제안**: `bookmark.savePair` → `{left, right}` 레코드, 사이드바 ⇄ 아이콘, 열면 두 패널 동시 이동(+sync browse 옵션).

#### BM-13 · `+` 버튼의 의미가 섹션마다 다르고 무엇을 북마크할지 알려주지 않는다

- **심각도**: Low · **레이어**: FE
- **현재 동작**: Hosts `+` = ad-hoc 접속, Bookmarks `+` = 활성 탭을 이름 없이 즉시 북마크, Places = ⟳, Recent = ✕, Shelf `+` = 새 섹션. 어느 패널의 어떤 경로가 저장되는지 표시 없음.
- **상용 툴**: TC 이름 프롬프트, Cyberduck `+` = 편집 폼, ForkLift `+` 현재 폴더.
- **문제**: 원격 탭에서 누르면 Local/Remote 어디로 가는지 예측 불가.
- **제안**: `+` 클릭 시 작은 메뉴 "왼쪽 패널 폴더(~/x) 북마크 / 오른쪽 … / 이름 지정해 추가…", 툴팁에 경로.

#### BM-14 · Places 라벨 미번역·숨김 불가, Volumes 는 Windows ejectable 과잉·종류 구분 없음

- **심각도**: Low · **레이어**: BE + FE
- **현재 동작**: `places()` 라벨이 영문 상수(`system.rs:422-429`) 로 그대로 렌더 → 한국어 UI 에서 "Home/Downloads". 항목 숨기기 없음. Windows 볼륨은 `ejectable = 드라이브 ≠ SystemDrive` (`system.rs:532`) → 고정 D: 에도 Eject 버튼. macOS 는 root dev 와 다르면 전부 ejectable, 아이콘은 전부 `HardDrive`. 용량/여유 공간 없음.
- **상용 툴**: Finder 내장/외장/네트워크 아이콘 + ejectable 에만 ⏏, Explorer 용량 바, Dolphin 여유 공간 바 + 숨기기.
- **문제**: 고정 디스크 "꺼내기" 는 오작동 위험(실패 토스트로 끝나긴 함), 네트워크 공유가 로컬 디스크처럼 보인다.
- **제안**: 라벨 i18n 키. `Volume.kind: Internal|External|Network|Optical` + `free/total`; Windows 는 `GetDriveType` (platform/, unsafe 주석) 또는 이동식 판정 전엔 `ejectable=false`.

#### BM-15 · Shelf 는 비어 있으면 아예 안 보이고, 세션이 끝나면 사라지며, 혼합 소스는 첫 그룹만 적용

- **심각도**: Low · **레이어**: FE
- **현재 동작**: `ShelfSection.tsx:41-43` 항목이 없으면 `null`. 진입점은 우클릭 "Add to shelf"/`Ctrl+Shift+A`/팔레트뿐. 메모리 전용(`shelf.ts:11-12`). Shelf 헤더로 드롭 불가. 적용 시 소스별 그룹 중 첫 그룹만 plan, 나머지는 "다시 적용" 토스트(`fileActions.ts:447-471`).
- **상용 툴**: ForkLift Drop Stack 은 항상 보이는 사이드바 탭, Yoink 는 드래그 시작 시 나타남.
- **문제**: 좋은 기능인데 발견 경로가 우클릭 메뉴 하나.
- **제안**: 드래그 시작 시 빈 Shelf 를 드롭 존으로 노출 + 힌트, 헤더 컨트롤은 hover/메뉴로, alias 기반 localStorage 영속, 그룹 순차 plan→execute.

#### BM-16 · 사라진 경로/언마운트된 볼륨의 북마크가 정상처럼 보인다

- **심각도**: Low · **레이어**: FE (+선택 BE)
- **현재 동작**: 존재 검사 없음. 열기 실패 시에만 `toast.cannotOpen`, 행은 계속 정상 표시, 제거 유도 없음.
- **상용 툴**: Finder 사라진 볼륨 흐리게/제거, Explorer 깨진 아이콘, DOpus 툴팁 경고.
- **문제**: 외장 디스크/임시 경로 북마크가 쌓여도 정리할 단서가 없다.
- **제안**: 열기 실패한 id 를 `stale` 로 표시(경고 아이콘 + 메뉴 Remove), 선택적으로 `bookmarks_check(ids)` 일괄 stat.

#### BM-17 · 아이콘 의미가 어긋나고 개인화(색/이모지) 여지가 없다

- **심각도**: Low · **레이어**: FE
- **현재 동작**: 저장 호스트 행이 lucide `Bookmark` 아이콘(`Sidebar.tsx:985`), 정작 북마크는 `Star`, 원격 즐겨찾기는 `Heart`, config 호스트는 `StateDot` 만. 항목별 색/이모지 없음.
- **상용 툴**: Termius 호스트 색/아이콘, WinSCP 세션 색, Transmit 즐겨찾기 아이콘.
- **문제**: "Bookmark 아이콘 = 저장 호스트" 는 학습을 방해. prod/staging 구분 신호가 없다.
- **제안**: 저장 호스트는 `Server`, 북마크/즐겨찾기는 BM-05 통합 후 단일 아이콘. 호스트별 accent 1색("prod=danger" 정도)은 후속.

### 탐색·탭·목록·키보드 (20건)

목록 자체(새로고침 시 커서 유지, 느린 원격 로딩 처리, 마키 선택, 탭별 정렬 영속)는 상용 툴급이다. 빠진 것은 키보드 선택 모델과 "떠나온 곳으로 돌아가는" 커서, 그리고 탭 전환 시 갱신·감시 — 셋 다 프론트만으로 고칠 수 있다. macOS 기본 키맵은 시스템 예약 키를 밟고 있다.

**잘 되어 있는 것 (상용 툴 동급 이상):**

- 같은 폴더 새로고침 시 커서·선택을 이름 기준으로 유지 (`panes.ts:296-325`) — TC 는 인덱스 기준이라 항목이 밀리는데 이건 더 낫다.
- 느린 원격 탐색 중 이전 목록 유지 + 200ms 지연 스피너 (`Pane.tsx:189-198`). ForkLift/Cyberduck 보다 자연스럽다.
- 마키(러버밴드) 선택 + 가장자리 자동 스크롤 + Ctrl 추가 선택 (`useMarquee.ts`). TC 엔 없고 Explorer/DOpus 수준.
- 패턴 선택 바 `Ctrl+=`/`Ctrl+-` (`SelectPatternBar.tsx`) — TC NumPad +/- 와 동등.
- 정렬/뷰/숨김이 탭 단위 + 세션 저장, 컬럼 폭 드래그 영속. DOpus 식.
- 탭 우클릭 메뉴·가운데 클릭 닫기·탭을 반대 패널로 이동·패널 교환 (`TabBar.tsx`, `panes.ts:626-656`).
- frecency 점퍼 `Ctrl+J`, 패널 안 연결 배너 — 상용 파일 매니저 대부분에 없는 기능.

#### NV-01 · 키보드 선택 모델이 사실상 없음 — Shift+↑↓, Home/End, PgUp/PgDn, Insert, Ctrl+A, 반전 전부 부재

- **심각도**: High · **레이어**: FE · ✔ 직접 검증 · **고침**: Shift 범위·Home/End·PgUp/Dn·Insert + Ctrl+A / Ctrl+Shift+A / Ctrl+Shift+I 커맨드
- **현재 동작**: `useKeyboardNav.ts:61-124` 가 처리하는 키는 Escape/Arrow/Enter/Backspace/Tab/Space 뿐. ArrowUp/Down 은 `e.shiftKey` 를 보지 않는다. `src/` 전체에 `Home`/`End`/`PageUp`/`Insert`/`Ctrl+A`/`selectAll`/`invert` 가 한 곳도 없음(Sidebar 의 "Home" 라벨 제외). Select 카테고리 커맨드는 `select.byPattern`/`removeByPattern` 둘뿐. DESIGN.md 키 표에는 `Shift+↑↓`, `Ctrl+A` 가 있으나 미구현.
- **상용 툴**: TC Insert/Space 선택+진행, Shift+↑↓ 범위, NumPad `*` 반전, Ctrl+A, Home/End/PgUp/PgDn. DOpus/Explorer/Finder/ForkLift 모두 Shift 범위 + Ctrl/⌘+A.
- **문제**: 1만 항목 폴더에서 끝으로 가려면 ↓ 1만 번. 키보드로는 인접 파일 두 개도 같이 선택할 수 없어 F5/F6 대상이 항상 커서 1개.
- **제안**: anchor 기반 Shift+↑↓/Shift+Home/End, Home/End, PageUp/Down(`densityMetrics().row` × 뷰포트), Insert = 토글 후 +1. `commands.ts` 에 `select.all`, `select.invert`, `select.allFiles`, `select.none` 등록 → 팔레트·치트시트·keymap 자동 노출.

#### NV-02 · macOS 시스템 단축키와 정면 충돌하는 기본 키맵 (Ctrl→⌘ 일괄 매핑의 부작용)

- **심각도**: High · **레이어**: FE
- **현재 동작**: `keyEvent.ts:16` 이 meta/ctrl 을 모두 `Ctrl` 로 정규화, `keyDisplay.ts:22` 가 표시 시 ⌘ 로 되돌린다. 그 결과 맥에서: 정렬 `Ctrl+Shift+3/4/5` (`commands.ts:289-309`) → ⇧⌘3/4/5 는 OS 스크린샷; 선택 토글 ⌘Space = Spotlight, ^Space = 입력 소스 전환; `tab.next` 는 ⌘⇥ 로 표시되지만 앱 전환기(실제 동작은 ^⇥); `Ctrl+H` → ⌘H 앱 숨기기(Tauri 기본 메뉴, 실기 확인 필요); `F11` → 데스크탑 보기; F1/F2/F5/F6/F7 은 맥북에서 Fn. 반대로 맥 사용자가 기대하는 ⌘↑(상위), ⌘⇧G(경로), ⌘⌫ 는 없음.
- **상용 툴**: ForkLift ⌘↑ 상위, ⌘⇧G 이동, ⌘1/2/3 뷰. Finder 동일. TC/DC/DOpus 는 Windows 전용이라 이 문제가 없다.
- **문제**: DESIGN "macOS 는 Cmd, 자동 매핑" 이 단순 치환이라 시스템 예약 키를 밟는다. 맥에서 정렬 3종·선택 토글·미리보기 토글이 키보드로 불가능.
- **제안**: `defaultKey` 를 `{ default, mac? }` 로 플랫폼 분리. 맥 기본: 정렬 `⌘⌥1..5`, 선택 토글 대체키, 상위 `⌘↑`, 경로 `⌘⇧G`, 미리보기 `⌘⇧P`. `keyEvent.ts` 에서 Ctrl/Meta 구분 저장, 치트시트에 `^`/`⌘` 정확 표기. 구두점·숫자·NumPad 는 `e.code` 매칭.

#### NV-03 · 상위로 갈 때 떠나온 폴더에 커서가 앉지 않음 + 뒤로/앞으로 시 커서·스크롤 미복원

- **심각도**: High · **레이어**: FE · ✔ 직접 검증 · **일부 고침**: 상위 이동 시 떠나온 폴더에 커서. 뒤로/앞으로의 커서·스크롤 복원은 후속
- **현재 동작**: `panes.ts:307-309` — `navigated` 면 무조건 `cursorIndex = 0`. `onUp`(`App.tsx:363-386`) 은 `navigate(id, parent)` 만 호출. 히스토리 스택은 `Location` 만 저장(`panes.ts:52, 280-286`), `onBack/onForward` 도 커서 0. 루트가 아니면 인덱스 0 은 합성 `..` 행이라 위로 간 직후 Enter 를 누르면 또 위로 간다.
- **상용 툴**: TC/DC/DOpus 모두 상위로 가면 떠나온 폴더에 커서. DOpus/Explorer/ForkLift 는 뒤로 가기 시 스크롤·선택 복원.
- **문제**: 깊은 트리를 오르내리며 형제 폴더를 비교하는 가장 흔한 워크플로우가 매번 "커서 찾기" 부터. 1천 항목 폴더에서 뒤로 가면 맨 위.
- **제안**: `setEntries` 에 `opts.focusName` — `onUp` 은 basename, `onBack/Forward` 는 히스토리에 저장해 둔 `{cursorName, scrollTop}`. `..` 가 있을 때 진입 기본 커서는 첫 실제 항목 옵션 검토.

#### NV-04 · 세션 복원이 SSH 탭을 버리고, 탭 잠금·이름·순서변경·호스트 표시가 없음

- **심각도**: High · **레이어**: BE + FE
- **현재 동작**: `session.ts:19` `filter(kind === "local")` — SSH 탭은 저장조차 안 함. `TabState` 에 lock/title/pinned 없음. `TabBar.tsx` 드래그 재정렬 없음, 라벨은 basename 만이라 로컬 `/var/log` 와 원격 `/var/log` 탭이 똑같이 보인다. 복원은 탭마다 순차 `await navigate` (`App.tsx:1583-1592`).
- **상용 툴**: TC 탭 잠금(잠긴 탭에서 이동하면 새 탭), 이름 변경, 세션 저장. DOpus 탭 그룹·잠금 3종. ForkLift/Transmit/WinSCP 는 재시작 시 원격 탭까지 복원.
- **문제**: SSH 작업 위주 앱인데 재시작하면 원격 쪽 문맥이 전부 사라진다. "항상 여는 서버 로그 폴더" 고정 탭을 만들 수 없다.
- **제안**: 세션에 SSH 탭을 `{alias, path}` 로 저장 → 부팅 시 alias 로 재접속(vault backend-only 정책과 부합), 실패 시 disconnected 탭으로 남겨 배너 Reconnect(`onPaneReconnect` 가 경로 복귀 지원). `TabState.locked/title`, TabBar 에 호스트 프리픽스 + `useReorderable` 드래그. 복원은 `Promise.all`.

#### NV-05 · 탭 전환 시 목록 갱신·감시자 재설정이 없음 → 낡은 목록 + 자동 새로고침 끊김

- **심각도**: High · **레이어**: FE · ✔ 직접 검증 · **고침**: 탭 전환 시 재로드 + pane_watch_set 갱신
- **현재 동작**: `selectTab` 은 순수 store 액션(`panes.ts:264-269`), `nextTab/prevTab` 도 그것만. `paneWatchSet` 은 navigate/navigateTo/syncMirror 안에서만(`App.tsx:191, 223, 263`) 호출돼 백엔드 감시자는 "그 패널이 마지막으로 navigate 한 경로" 에 고정. `useFsChangedEvents.ts:22-27` 는 이벤트 경로와 활성 탭 경로를 비교하므로 전환해 온 탭의 폴더는 아무도 감시하지 않는다.
- **상용 툴**: TC/DOpus 탭 활성화 시 재읽기 + 활성 탭 폴더 감시. Explorer 탭마다 감시.
- **문제**: 탭 A→B→A 로 돌아오면 B 에서 만든 파일이 A 목록에 안 보이고, 외부 변경도 반영 안 됨. "새로고침을 눌러야 하는 앱" 이라는 인상.
- **제안**: App 에 `activeTabIndex` 변화 구독 → `onRefresh(id)` + `paneWatchSet(id, loc)`. 탭 닫기/이동/스왑 후에도 동일. 백엔드 API 는 이미 있다.

#### NV-06 · 타이핑으로 파일명 점프(type-ahead) 없음 — 글자를 쳐도 아무 일도 안 일어난다

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `useKeyboardNav.ts` 에 문자 키 처리 없음. 유일한 문자 바인딩은 `filter.focus` 의 `altKeys: ["/"]`. 목록에서 `d` 를 눌러도 무반응.
- **상용 툴**: Finder/Explorer/ForkLift/DC 타이핑 즉시 이름 점프. DOpus 는 타이핑이 필터 필드로(설정). TC 는 옵션으로 즉시 검색.
- **문제**: 모든 OS 탐색기 사용자가 가진 근육 기억이 무시된다. 큰 원격 폴더에서 "p 눌러서 public/" 가 안 된다.
- **제안**: 1초 버퍼 prefix 매칭(`computeDisplayed` 순서, `..` 제외). 설정 "타이핑 = 점프 / 필터 열기". `/` 는 유지.

#### NV-07 · 자연 정렬 없음(`file10` 이 `file2` 앞), 폴더 우선이 하드코딩

- **심각도**: Med · **레이어**: FE · ✔ 직접 검증 · **일부 고침**: 자연 정렬 적용. dirs_first 설정화는 후속
- **현재 동작**: `panes.ts:724` `a.name.localeCompare(b.name)` — `numeric` 옵션 없음. `dirsFirst` 는 `sortEntries` 안에 고정(717-723, 746-751). DESIGN.md "설정으로 변경 가능" 과 불일치.
- **상용 툴**: Explorer/Finder/DOpus/ForkLift 모두 자연 정렬 기본. TC 옵션. DOpus/TC 폴더 혼합 정렬 옵션.
- **문제**: `img_1, img_10, img_11, img_2 …` — 사진/로그 폴더에서 매번 거슬린다. 최근 수정순으로 폴더·파일을 섞어 보기 불가.
- **제안**: 모듈 레벨 `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })` 로 교체(성능도 좋아짐). `tabDefaults.dirsFirst` → Settings 노출.

#### NV-08 · 경로 입력이 "빈 텍스트박스" — 자동완성·히스토리·`~` 없음, breadcrumb 형제 드롭다운 없음, 긴 경로가 말단부터 잘림

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: `PathBar.tsx:280-299` 편집 모드는 `<input>` 하나, Enter 로 문자열을 그대로 `listDirectory` 에 전달. 백엔드에 `~` 확장 없음. breadcrumb 세그먼트는 클릭만, 컨테이너가 `truncate` 라 깊은 세그먼트(현재 폴더명)가 잘린다(`:309`). blur 시 편집 조용히 취소.
- **상용 툴**: Explorer 주소창 자동완성 + 세그먼트 ▾ 형제 폴더. DOpus 동일 + 히스토리. ForkLift/Finder ⌘⇧G 자동완성, `~` 지원.
- **문제**: 원격에서 `/var/log/nginx` 를 치려면 전부 외워서 정확히 쳐야 하고 실패는 토스트만. breadcrumb 에서 형제로 옮기려면 3단계.
- **제안**: `fs_complete_path(location, prefix, limit)` (로컬 read_dir, 원격 SFTP readdir, 디렉토리만) + `~` 확장은 platform/. PathBar 드롭다운(↑↓/Tab), 히스토리 재사용, 세그먼트 ▾ 형제 목록, 오버플로 시 앞 세그먼트를 `«` 로 접기.

#### NV-09 · 권한/소유자 컬럼 없음, 컬럼 표시 선택 불가, 심볼릭 링크 표식 소실

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: `EntryList.tsx:177-216` Name/Ext/Size/Modified 고정, 헤더 우클릭은 확장자 컬럼 토글 하나. `Entry` 에 `permissions` 는 있으나 상태바에만 표시, owner/group/link_target 없음(`types/mod.rs:63-73`). 원격 list 는 링크를 따라가 target 종류로 분류(`fs/ssh.rs:595-609`) → 디렉토리 링크 네비는 되지만 링크 표식이 사라진다. `columnWidths` 는 패널/소스 구분 없이 하나.
- **상용 툴**: TC 사용자 컬럼 세트, DOpus 폴더 포맷별 컬럼, ForkLift/Cyberduck/WinSCP/FileZilla 원격에서 Permissions/Owner/Group 기본 + 링크 아이콘.
- **문제**: 서버에서 `www-data` 소유가 아닌 파일을 찾거나 `-rw-------` 를 훑는 게 SSH 파일 매니저의 핵심 용도인데 한 항목씩 상태바를 봐야 한다. 링크를 폴더로 착각해 복사하면 실체가 복사됨을 인지 못한다.
- **제안**: `Entry` 에 `owner/group: Option<String>`, `is_symlink`, `link_target` (SFTP attrs uid/gid·longname — russh-sftp 필드 지원 확인 필요; 로컬 유닉스는 platform/). `columnVisibility` store(원격 기본 Perms/Owner on) + 헤더 메뉴 체크박스 + `SortKey.perms`.

#### NV-10 · "커서 항목을 반대 패널에서 열기" / "새 탭에서 열기" 단축키 없음 (+ 경로 결합 규칙 위반)

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `onOpenInOtherPane` 은 우클릭 전용(`App.tsx:501-510`), 커맨드 없음. 새 탭에서 열기는 메뉴에도 없음. `App.tsx:507-508` 은 `tab.location.path + sep + entry.name` 문자열 결합 — 다른 곳은 `childLocation` 을 쓰는데 여기만 CLAUDE.md §7 위반.
- **상용 툴**: TC/DC Ctrl+←/→ 커서 폴더를 반대 패널에, Ctrl+↑ 새 탭. ForkLift Open in other pane.
- **문제**: 듀얼 패널의 존재 이유(양쪽 비교)를 키보드로 못 한다.
- **제안**: `pane.openInOther` (`Ctrl+Right`/`Ctrl+Left`), `tab.openInNew` (`Ctrl+Up`) 커맨드 + 메뉴 단축키 표시. `App.tsx:507` 을 `childLocation` 으로.

#### NV-11 · 원격 탐색 요청 경쟁 조건 — 취소/순서 보장 없음

- **심각도**: Med · **레이어**: FE (→ BE)
- **현재 동작**: `navigate` (`App.tsx:177-207`) 에 요청 토큰/AbortController 없음. 느린 SSH 에서 폴더 A 더블클릭 직후 뒤로를 누르면 두 `listDirectory` 가 동시에 진행되고 늦게 도착한 쪽이 최종 상태 — 히스토리는 둘 다 push. 로딩 오버레이는 클릭을 막지 않아 재현이 쉽다.
- **상용 툴**: ForkLift/Cyberduck 진행 중 목록 취소, 최신 요청만 반영. DOpus 폴더 읽기 취소(Esc).
- **문제**: 큰 원격 폴더에서 "클릭했는데 다른 폴더가 열림" 으로 체감.
- **제안**: 패널별 `navSeq` 토큰 — 응답 도착 시 최신이 아니면 폐기. Esc 로 로딩 취소. 후속으로 SFTP readdir 취소.

#### NV-12 · 상태바: 비활성 패널 정보 없음, 여유 공간 없음, 집계가 화면과 불일치

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: `StatusBar.tsx:30-31` 활성 패널만. 집계는 `tab.entries`(원본) 기준이라 숨김이 꺼져 있거나 필터 중이어도 "12 files" 는 전체 수. 선택 용량은 `size != null` 파일만, 계산해 둔 `dirSizes` 미반영. 여유 공간은 프론트/백엔드 어디에도 없음.
- **상용 툴**: TC 패널마다 "선택 k/전체, n/m 파일" + 드라이브 여유. DOpus 패널별 상태 + 디스크 바. Finder "n items, xx GB available". ForkLift 패널별.
- **문제**: 큰 파일을 서버로 올리기 전에 서버 여유 공간을 알 수 없다(핵심 시나리오). 왼쪽에서 선택해 두고 오른쪽으로 포커스를 옮기면 선택 정보가 사라진다.
- **제안**: `fs_disk_free(location)` — 로컬 statvfs(platform/), 원격 `df -Pk` exec 파싱. 상태바를 좌/우 2구역(표시 n · 선택 k (size) · 여유 X) + 가운데 커서 상세. 집계는 `computeDisplayed` 기준.

#### NV-13 · Space = QuickLook / Ctrl+Space = 토글 — TC 계열 기대와 어긋나고, 하드와이어드라 재바인딩 불가, 토글 후 커서가 진행하지 않음

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `useKeyboardNav.ts:108-123` Space 는 QuickLook, Ctrl/⌘+Space 만 토글, 토글 후 커서 정지. Insert 무처리. Enter/Backspace/Tab/Space 는 하드와이어드라 keymap 에서 못 바꾼다(치트시트 주석). DESIGN.md 키 표는 "토글 선택 | Space".
- **상용 툴**: TC/DC/DOpus/WinSCP Space = 선택(+폴더 크기), Insert = 선택+아래로. Finder/ForkLift 만 Space = QuickLook.
- **문제**: TC 대체가 목표인데 TC 사용자의 가장 잦은 키가 다른 동작. 연속 토글이 "Ctrl+Space, ↓" 4배 타건. CLAUDE.md "키바인딩 하드코딩 금지" 와 긴장.
- **제안**: `select.toggle`, `nav.enter`, `nav.up`, `pane.switch` 를 커맨드로 승격(기본키는 현재대로) → keymap 교체 가능. Insert = 토글+진행, Ctrl/⌘+Space 도 진행. 설정 "Space: Quick Look / 선택". DESIGN.md 표 갱신.

#### NV-14 · 정렬 키가 DESIGN.md 와 다르고, 번호로 탭 이동하는 커맨드가 없음

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `commands.ts:275-309` 정렬은 `Ctrl+Shift+1..5` (DESIGN 은 `Ctrl+1..5`). 탭 N 선택 커맨드 자체가 없음(`tab.next/prev` 만). DESIGN 의 "Alt+1..9 도 지원" 미구현.
- **상용 툴**: DOpus/브라우저/ForkLift Ctrl/⌘+1..9 탭. VS Code Ctrl+1..9.
- **문제**: 탭 3개 이상이면 Ctrl+Tab 반복. 맥에선 NV-02 로 정렬 키 3개가 죽는다.
- **제안**: `tab.goto:1..9` (기본 `Alt+1..9`, 맥 `⌘1..9`), 정렬은 `Ctrl+Alt+1..5` 로 이동, DESIGN.md 표 갱신. BM-06 의 북마크 번호와 키 배분 결정 필요.

#### NV-15 · 동기화 브라우징이 진입/위로에만 동작하고 실패가 조용하다

- **심각도**: Low · **레이어**: FE
- **현재 동작**: `App.tsx:376-381`, `403-407` 에서만 `syncMirror`. breadcrumb 클릭·경로 입력·뒤로/앞으로·사이드바 이동은 미동행. 반대편에 같은 이름이 없으면 조용히 skip.
- **상용 툴**: TC Synchronize directory browsing 은 모든 상대 이동 동행. DOpus Navigation Lock 은 실패 시 잠금 해제 알림.
- **문제**: 두 서버의 릴리스 폴더를 비교하다 breadcrumb 으로 올라가면 한쪽만 이동.
- **제안**: `navigate` 내부에서 이전→새 path 의 상대 차이를 반대편에 적용(back/forward 포함). 미존재 시 툴바 아이콘 경고색 + 토스트 1회.

#### NV-16 · 빠른 필터가 부분문자열 전용, 필터 중 `..` 가 사라짐, 필터 고정 옵션 없음

- **심각도**: Low · **레이어**: FE
- **현재 동작**: `panes.ts:695-698` `includes` 매칭만. `:706` 필터가 있으면 `..` 행 제거. 이동 시 필터 초기화(`:334`) — DOpus 식 "고정 필터" 없음.
- **상용 툴**: DOpus 필터 바 와일드카드/정규식 + 유지 옵션. ForkLift 필터 유지.
- **문제**: 필터 상태에서 마우스로 위로 가려면 툴바 ↑ 뿐.
- **제안**: 패턴에 `*?[` 가 있으면 `patternToMatcher`, 아니면 substring. `..` 는 필터 무관 유지. 필터 고정 핀.

#### NV-17 · 사이드바/미리보기 열림 상태가 재시작 시 초기화

- **심각도**: Low · **레이어**: FE
- **현재 동작**: `ui.ts:121-124` `sidebarOpen`, `previewOpen` 은 localStorage 없이 항상 true. 같은 파일의 density/splitExt/syncBrowse/singlePane 은 영속. 정보 패널은 DESIGN 상 "보조" 인데 매번 260px 를 다시 차지한다.
- **상용 툴**: 전부 레이아웃 복원.
- **문제**: 닫아 둔 패널이 매번 돌아온다.
- **제안**: `loadBool`/`saveBool` 를 두 토글에도 적용(기존 패턴 그대로).

#### NV-18 · 루트에서 ↑ 버튼이 활성처럼 보임, 마지막 탭 Ctrl+W 무반응

- **심각도**: Low · **레이어**: FE
- **현재 동작**: `PathBar.tsx:235` `disabled={!onUp}` 인데 `Pane.tsx:141` 이 항상 `onUp` 을 넘겨 루트에서도 활성 표시. `closeTab` 은 탭 1개면 no-op(`panes.ts:225`).
- **상용 툴**: Explorer/DOpus 루트에서 ↑ 비활성. 브라우저/DOpus 마지막 탭 닫기 = 창 닫기 또는 홈 리셋.
- **문제**: 눌러도 아무 일 없는 컨트롤.
- **제안**: `canUp` prop. 마지막 탭 Ctrl+W 는 홈으로 리셋(또는 설정으로 창 닫기).

#### NV-19 · 키 표기/매칭 세부 — 문서의 `Esc` 는 매칭 불가, 레이아웃 의존 키, NumPad 미바인딩

- **심각도**: Low · **레이어**: FE · **일부 고침**: NumPad 를 e.code 로 구분해 바인딩 가능 + 패턴 선택/반전 alt 키. Esc 표기 문서는 후속
- **현재 동작**: `keymap.toml.example:9` 는 `"Esc"` 를 예시로 들지만 `formatKeyEvent` 는 `"Escape"` 를 만든다 → 그 바인딩은 절대 안 맞는다. `"/"`, `"Ctrl+="`, `"Ctrl+-"` 는 `e.key` 기반이라 독일어 등 배열에서 `Shift+/` 로 잡힌다. NumPad `+ - *` 는 TC 사용자가 가장 먼저 누르는 키인데 바인딩 없음.
- **상용 툴**: TC NumPad +/-/*.
- **문제**: 문서대로 해도 안 되는 키가 있다.
- **제안**: 문서 수정, 구두점/NumPad 는 `e.code` 로 정규화, NumPad +/-/* 를 `select.byPattern/removeByPattern/invert` altKeys 로.

#### NV-20 · 플랫(브랜치) 뷰·폴더 트리·컬럼 뷰 부재

- **심각도**: Low · **레이어**: BE + FE
- **현재 동작**: 재귀 평면 목록 모드 없음. `Ctrl+B` 는 사이드바 토글.
- **상용 툴**: TC Ctrl+B 브랜치 뷰, DOpus Flat View, DOpus/Explorer 폴더 트리, Finder/ForkLift 컬럼 뷰.
- **문제**: "이 트리 전체에서 `.log` 만 골라 지우기" 는 전역 검색 → 결과 패널로 우회해야 한다(CF-04 참조).
- **제안**: `list_directory_recursive(location, depth, glob)` + `TabState.flat`, 이름 컬럼에 상대 경로. 후순위.

### 설정·팔레트·검색·다이얼로그·알림 (20건)

다이얼로그 셸·키맵 편집기·체크섬·권한 undo 는 상용 툴보다 낫다. 문제는 설정의 폭 — 예시 TOML 이 존재하지 않는 키 17개를 약속하고, 실제 설정은 12개 필드뿐이라 충돌 기본값·확인창·날짜/크기 포맷·편집기 같은 기대 항목이 전부 비어 있다. 설정 화면 4개 섹션이 영어 하드코딩인 것도 첫인상을 깎는다.

**잘 되어 있는 것 (상용 툴 동급 이상):**

- DialogShell 일관성 — 12개 다이얼로그가 같은 셸(폭 5단계, 헤더 X 없음, Esc/↵ 힌트, 푸터 좌측 집계). ForkLift/TC 보다 일관.
- 키맵 편집기 — 검색·충돌 경고·커스터마이즈 점·복원·키 캡처, `keymap.toml` 핫 리로드, 팔레트/치트시트가 리바인드 반영.
- 체크섬 — 원격은 호스트 측 해시(다운로드 0), 기대값 붙여넣기 검증, `sha256sum` 포맷 복사. WinSCP 보다 실용적.
- 권한 변경 undo — 비재귀 chmod 는 되돌릴 수 있고 재귀/chown 은 danger 톤으로 비가역 명시.
- 권한 상승 흐름 — Windows UAC / 원격 sudo 자동 재시도 (`useTaskEvents.ts:110-120`). TC/DOpus 엔 없는 안전망.
- 컨텍스트 메뉴 엔진 — 키보드 완전 조작, 지연 로딩 서브메뉴로 Windows 셸 메뉴 합성, 뷰포트 클램프.
- 미리보기 범위 — 텍스트(구문강조/마크다운)·이미지·PDF·미디어 스트리밍·Quick Look, 원격도 동일. TC Lister 보다 넓다.

#### CF-01 · `settings.toml.example` 이 존재하지 않는 설정 17개를 약속하고, 경로·구조도 실제와 다름

- **심각도**: High · **레이어**: settings/docs · ✔ 직접 검증 · **고침**: 예시 파일을 실제 스키마(평면 16키)로 다시 씀 + 저장 위치 명시
- **현재 동작**: 예시는 `~/.duet/config.toml` 로 복사하라 하고 `[general]/[panes]/[safety]/[ssh]/[ui]/[advanced]` 섹션 구조. 실제는 `<config_dir>/duet/settings.toml` (`settings.rs:117`) 이고 섹션 없는 평면 struct 12필드. 예시에만 있는 키: `restore_session, row_height, layout, left_ratio, dirs_first, enable_permanent_delete(이름 다름), trash_retention_days, remote_trash_dir, backup_on_overwrite, fallback_strategy, load_ssh_config, host_key_check, max_connections_per_host, auto_reconnect, sidebar_visible, sort_descending, log_level, concurrent_tasks`. 모르는 키는 조용히 무시된다(테스트가 보장).
- **상용 툴**: TC `wincmd.ini`, Double Commander, WinSCP 는 문서화된 키가 실제로 동작.
- **문제**: 예시대로 파일을 써도 아무 일도 안 일어나고 에러도 없다. `remote_trash_dir`, `host_key_check` 는 안전/보안 관련이라 신뢰 문제.
- **제안**: 예시 파일을 실제 스키마로 재생성(경로·평면 구조·12키), 미구현 키는 "계획" 주석으로 분리하거나 삭제. unknown key 를 `tracing::warn` + 부팅 토스트로.

#### CF-02 · 설정 항목 커버리지 — 사용자가 기대하는 핵심 동작에 설정이 없음

- **심각도**: High · **레이어**: settings + FE (+BE)
- **현재 동작**: 충돌 기본값(OP-01), 확인 다이얼로그 on/off(OP-02, OP-11), 날짜 포맷(한 컬럼에 세 포맷 혼용 `format.ts:26-36`), 크기 단위(1024 나누기 + `KB/MB` 라벨 — 값은 KiB 인데 표기는 KB, `format.ts:9-20`), 폴더 우선/자연 정렬(NV-07), 외부 에디터/F4(`file.edit` 커맨드 자체가 없음, DESIGN 키 표엔 F4=Edit), 터미널 앱 선택, 폰트 크기, 밀도 3단(현재 2단), 원격 휴지통 경로/보관일/동시 작업 수 — 전부 설정 없음.
- **상용 툴**: WinSCP Transfer/Editors/Panels, TC Operation(확인 토글 6종)/Display(포맷·자연 정렬), ForkLift General(When file exists, Terminal/Editor 앱), Finder View Options.
- **문제**: 매 복사마다 초기화되는 충돌 정책, 매 삭제마다 확인창, 편집기 없이 F4 없음 — TC/WinSCP 사용자에게 가장 먼저 걸리는 벽. 크기 표기는 Finder 값과 어긋나 "왜 duet 은 작게 나오지?".
- **제안**: 1차: `conflict_default`, `confirm_trash_delete`, `confirm_copy_move`, `size_units(binary|decimal|bytes)`, `date_format(relative|locale|iso)`, `dirs_first`, `natural_sort`, `editor_command`, `terminal_command`. General 을 외관/목록/파일 작업/안전 그룹으로 재편. `file.edit`(F4) 추가 — 로컬은 editor_command, 원격은 기존 edit-roundtrip.

#### CF-03 · i18n — 설정 화면 4개 섹션이 통째로 영어 하드코딩, 그 외 30여 곳 산재

- **심각도**: High · **레이어**: FE · **일부 고침**: 설정 General 섹션·목록 컬럼 헤더·스토어 토스트 i18n. Aliases/ExtIcons/OpenWith 섹션은 후속
- **현재 동작**: `GeneralSection.tsx:160-311` 언어/테마/밀도 3개만 `t()`, 나머지 전부 영어. `AliasesSection`, `ExtIconsSection`, `OpenWithSection` 은 `useTranslation` import 조차 없음. 그 외: `App.tsx:522,527,581,629` (Open parent folder / More options), `entryMenu.tsx:464-475` `SORTS/VIEWS` 라벨을 모듈 로드 시 고정 → 언어 전환 후에도 이전 언어; `EntryList.tsx:178-209` 컬럼 헤더 Name/Ext/Size/Modified; `EntryRow.tsx:62` Parent folder; `SelectPatternBar.tsx:49-51`; `ContextMenu.tsx:297`; `PreviewView.tsx` 7곳; `ErrorBoundary.tsx`; `dynamicCommands.ts:38,44` 팔레트 접두; 스토어 에러 토스트 12곳; `useTaskEvents.ts:121,124` "Operation failed —"; `lib/error.ts:12-25` `KIND_LABEL` 영어 고정 → 모든 에러 토스트 앞머리가 영어; 백엔드 task title 영어(`fs_ops.rs:1911-1931`); `toast.copiedItems` 의 "Ctrl+V" 리터럴(맥에서도 Ctrl). JSON 자체는 건강(ko 850/en 815, 누락은 복수형 규칙) — 문제는 `t()` 를 안 거치는 컴포넌트.
- **상용 툴**: TC/Double Commander/WinSCP 는 언어 팩이 설정 화면까지 완전 적용.
- **문제**: 한국어 UI 에서 설정 창을 열면 절반이 영어, 목록 헤더가 영어 — 첫인상이 "번역 미완성". 에러 토스트는 영어 라벨 + 한국어 접두가 섞인다.
- **제안**: 위 파일에 `t()` 적용 + 키 추가. `SORTS/VIEWS` 는 함수 안에서 호출. task title 은 구조화. `displayKey("Ctrl+V")` 보간. ESLint `i18next/no-literal-string` 검토(의존성 승인 필요).

#### CF-04 · 글로벌 검색 — 필터 없음, 결과에 아무 작업도 못 함

- **심각도**: High · **레이어**: BE + FE
- **현재 동작**: `SearchOpts` 는 case_sensitive/include_hidden/max_results/content 4개(`core/search.rs:17-24`), UI 는 앞 둘을 false 로 고정(`SearchPanel.tsx:83-88`). 정규식·크기/날짜/종류 필터 없음, 루트는 현재 폴더 고정. 결과 행은 이름+부모 경로만 — `SearchHit` 의 `size/modified_ms` 를 버린다. Enter = 첫 결과만, ↑↓ 이동 없음, 다중 선택/복사/이동/삭제/"결과를 패널에" 없음. 에러는 `r.error.kind` 문자열(화면에 "Io").
- **상용 툴**: TC Alt+F7(이름·내용·날짜·크기·정규식 + Feed to listbox 로 결과에 F5/F8), DOpus Find(필터 트리·컬렉션), ForkLift(Spotlight + 결과에서 바로 작업), Everything.
- **문제**: "지난주 이후 수정된 *.log 100MB 이상" 이 불가능하고, 찾은 파일을 모아서 지우려면 하나씩 이동해 처리해야 한다.
- **제안**: `SearchOpts` 에 `regex, min/max_size, modified_after/before, kinds, root_override` (원격은 `find -size/-mtime/-regex`). 필터 칩 바 + 결과 테이블(컬럼, ↑↓, Shift/Ctrl 선택) + "결과를 패널로"(가상 탭) + 우클릭에 `buildEntryMenu` 재사용. 에러는 `formatErr`.

#### CF-05 · 메뉴·툴팁·치트시트의 키 힌트가 하드코딩 — 리바인딩·플랫폼 미반영, altKeys 미표시

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `entryMenu.tsx` 의 `shortcut: "Ctrl+C"/"F5"/"Del"…` 19곳, `TabBar.tsx:98,129` 리터럴. i18n 문자열에 키가 박혀 있음(`toolbar.copy = "… (F5)"`, `pathbar.backTitle = "(Alt+←)"`). `TopBar.tsx` 는 `displayKey("Ctrl+B")` 처럼 표시 변환만 — `effectiveKey` 미사용. 치트시트는 `altKeys`(`/`) 를 안 보여준다. `useGlobalShortcuts.ts:48-56` 는 오버라이드가 없을 때만 폴백하는데, 다른 키를 바인딩해도 원래 기본 키가 계속 살아 있어 UI 표시와 실제 동작이 다르다.
- **상용 툴**: VS Code/DOpus 메뉴·툴팁이 현재 바인딩을 반영.
- **문제**: 키를 바꾼 사용자에게 메뉴가 거짓말을 한다. 맥에서 "Ctrl+H" 툴팁을 보고 ^H 를 누른다. 키맵 편집 기능을 정성껏 만든 것과 모순.
- **제안**: `useKeyHint(commandId)` 훅(`effectiveKey` + `displayKey`) 을 모든 title/shortcut 에, i18n 문자열에서 키 제거. `MenuItem.commandId`. altKeys 표시. 오버라이드 의미를 "대체" 로 통일.

#### CF-06 · 토스트가 DESIGN.md 와 어긋남 — 에러가 6초 후 사라지고, 성공 토스트가 잦으며, 행동할 수 없다

- **심각도**: High · **레이어**: FE (+BE) · **일부 고침**: 에러 토스트가 수동 닫기까지 유지 + 성공 토스트 절제. 액션 버튼(되돌리기/재시도)은 후속
- **현재 동작**: 위치 하단 중앙(`Toast.tsx:13`, DESIGN 은 우측 하단). 에러 6초 자동 소멸(`stores/toast.ts:19-23`, DESIGN "에러는 수동 닫기"). 클릭 확장·액션 버튼 없음. 성공 토스트: 모든 작업 완료마다(1개 파일 복사도), 클립보드 복사/잘라내기마다, 접속 성공마다(`App.tsx:1551`). `PermissionDenied` 는 Windows→UAC, SSH→sudo 로 분기하지만 macOS/Linux 로컬은 "Operation failed" 토스트뿐. 4개 상한이라 성공 토스트가 에러를 밀어낸다.
- **상용 툴**: ForkLift/Transmit 은 성공을 소리·상태바로, 실패는 시트로 남긴다. Finder 권한 실패 시 인증 대화상자. GNOME Files/Dolphin "Undo" 액션 토스트.
- **문제**: 6초 안에 못 읽은 에러는 증발한다(연결 실패 상세는 멀티라인).
- **제안**: `error` 는 `duration: null` + 수동 닫기; `actions?: {label, onClick}[]` (Undo / 재시도 / 위치 열기); 성공은 작업 시간 > 2s 또는 항목 ≥ N 일 때만; macOS/Linux 로컬 PermissionDenied 도 sudo 흐름(BE).

#### CF-07 · "영구 삭제" 가 설정 OFF 여도 메뉴·팔레트에 노출되고 실행 시점에야 실패

- **심각도**: Med · **레이어**: FE
- **현재 동작**: 프론트에서 `permanent_delete_enabled` 를 읽는 곳은 설정 토글뿐(`GeneralSection.tsx:254-263`). `entryMenu.tsx:443-450` "Delete permanently" 와 `commands.ts:461-467` `file.deletePerm`(Shift+Delete) 은 무조건 등록. 백엔드가 plan 단계에서 거부(`fs_ops.rs:515,687`, `ops.rs:194`) → 에러 토스트. 예시 TOML 은 "메뉴/단축키 비활성화" 라 적혀 있다.
- **상용 툴**: ForkLift/Finder 는 노출 자체를 옵션화하거나 숨긴다.
- **문제**: 위험 기능을 "꺼두었다" 고 믿는 사용자에게 danger 색 항목이 계속 보이고 누르면 에러. 안전 설계 메시지가 약해진다.
- **제안**: `useAppSettings.permanentDeleteEnabled` 미러(기존 패턴) → 메뉴·팔레트·단축키 조건부 등록. 단어 타이핑은 유지.

#### CF-08 · 커맨드 팔레트 — 최근 사용 없음, 카테고리 그룹 없음, 한국어 UI 에서 영어 검색 불가

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `fuzzyScore` 점수순만(`CommandPalette.tsx:36-49`); 빈 질의면 등록 순서 90여 개. 최근/빈도 저장 없음(`stores/palette.ts` 는 `isOpen` 만). 매칭 대상은 번역 라벨 하나 — 한국어에서 "hidden" 을 쳐도 안 잡힌다(`KeymapSection` 은 번역+원문+id+키 모두 매칭해 두 곳이 다르다). `>`/경로/`@호스트` 모드 없음.
- **상용 툴**: VS Code(recently used 상단, 카테고리 접두, `>`/`@`/`:` 모드), Raycast/Alfred(빈도 학습).
- **문제**: DESIGN 이 명시한 "최근 사용 명령 우선 표시" 미구현. 90개 목록에서 화살표로 찾는 비용.
- **제안**: `palette.recent`(localStorage 상위 5) → 빈 질의 시 "최근" + 카테고리 그룹 헤더; 매칭을 `commandLabel + cmd.label + cmd.id` 로; 경로처럼 보이면(`/`, `~`, `C:\`) "경로로 이동" 항목.

#### CF-09 · 미리보기 호버 추적이 원격에 I/O 를 발생시키고, 인스펙터 필드가 부족하다

- **심각도**: Med · **레이어**: FE + settings
- **현재 동작**: 대상은 호버 우선(`PreviewPane.tsx:137`) — 행에 마우스가 올라가면 150ms 뒤 `fsReadPreview`, 폴더면 200ms 뒤 `listDirectory`(`PreviewInspector.tsx:130-144`). SSH 패널 위를 마우스가 지나가면 경로마다 SFTP read/ls. 끄기 설정 없음. 인스펙터는 종류/항목수/크기/수정/권한/위치만 — 소유자/그룹, 생성일, 링크 대상, 열기 버튼 없음.
- **상용 툴**: ForkLift/Finder 인스펙터는 커서 항목만 따른다. Path Finder 는 소유자/그룹/생성일까지.
- **문제**: 원격에서 호버 I/O 는 체감 지연·트래픽·로그 노이즈 원인.
- **제안**: `preview_follow_hover` 설정(로컬만 기본 true, SSH 는 커서만) 또는 원격은 호버 건너뜀. NV-09 의 owner/group·링크 대상 표시.

#### CF-10 · 로컬 파일에 "앱으로 열기…" 가 없고, Open-with 는 확장자 단위 사전 등록뿐

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: `OpenWithSection.tsx` 는 "확장자 → 프로그램" 만. 컨텍스트 메뉴에 per-file "Open with ▸" 없음. Windows 만 셸 메뉴 "More options ▸" 로 OS Open-with 가 나온다. macOS/Linux 는 특정 파일을 다른 앱으로 열 방법이 없다. 앱 런처 스트립에 파일 드롭 없음.
- **상용 툴**: Finder/ForkLift/DOpus 우클릭 Open With ▸(앱 목록 + 기타…). ForkLift 툴바 앱에 드롭.
- **문제**: "이 png 를 이번만 Pixelmator 로" 가 불가.
- **제안**: `entryMenu` 에 "Open with ▸" — 등록 런처 + "다른 앱…"(파일 피커) + "이 확장자의 기본으로". 런처 타일 `onDrop` → `app_launch(path, [file])`.

#### CF-11 · 컨텍스트 메뉴가 DESIGN.md 스펙보다 2배 길고 "속성(Alt+Enter)" 이 없음

- **심각도**: Med · **레이어**: FE
- **현재 동작**: DESIGN 예시는 9항목·3구분선. 실제 SSH 단일 파일 메뉴는 약 22항목(`entryMenu.tsx:218-451`). "Properties Alt+Enter" 커맨드 없음; 대신 POSIX 전용 Permissions 와 인스펙터. 파일 위 메뉴에 New folder/New file 이 섞여 있다.
- **상용 툴**: Finder 12항목 내외, ForkLift 2단("More ▸"), TC 는 OS 메뉴 위임.
- **문제**: Rename/Delete 가 아래로 밀려 마우스 이동이 길다. Windows 로컬엔 Permissions 가 없어 속성 경로가 인스펙터뿐.
- **제안**: 빈도 낮은 항목(Compress/Checksum/Permissions/Shelf/Bookmarks/Copy name) 을 "More ▸" 로, `file.properties`(Alt+Enter) → 인스펙터 열기+포커스 또는 Windows 셸 Properties verb.

#### CF-12 · 설정 다이얼로그 — 검색 없음, 그룹 없음, 저장 위치 안내 없음, SoT 가 갈라져 있음

- **심각도**: Med · **레이어**: FE (+BE)
- **현재 동작**: 좌측 5개 버튼, General 은 구분선 2개뿐인 평면 목록(`GeneralSection.tsx:99-312`). 전체 검색·"기본값으로"·설정 폴더 열기 없음. 언어/밀도는 localStorage, 나머지는 TOML — `ErrorBoundary` 의 "Reset app state"(`localStorage.clear()`) 가 언어·밀도는 지우고 테마는 남긴다.
- **상용 툴**: VS Code/DOpus 설정 검색, WinSCP 페이지 트리 + Restore defaults, ForkLift 탭 + 소제목.
- **문제**: CF-02 를 반영하면 지금 구조로는 못 버틴다. 어디에 저장되는지 모르면 백업이 어렵다.
- **제안**: 소제목(외관/목록/동작/안전/OS 통합) + 상단 필터 입력 + 푸터에 `settings.toml` 경로와 "폴더 열기". 언어·밀도도 `Settings` 로 옮겨 SoT 하나로.

#### CF-13 · 에러 문구 파이프라인 — 원인별 다음 행동 없음, 검색 패널은 enum 이름 노출

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `formatErr` 가 kind → 영어 라벨 매핑 후 호출부가 한국어 접두를 붙인다. `NotSupported`, `HostKeyUnverified`, `CrossDevice` 도 문장뿐. 검색 에러는 `r.error.kind` 만(`SearchPanel.tsx:97,200-203` → "Io").
- **상용 툴**: WinSCP 에러 대화상자 Retry / Skip / Abort / Help; Cyberduck 원인 + 링크.
- **문제**: 사용자가 할 수 있는 일이 없다.
- **제안**: `error.kind.*` i18n; `errorHint(kind)` (HostKeyUnverified → 호스트 키 대화상자 열기, CrossDevice → 복사+삭제) 를 토스트 액션으로(CF-06). 검색 패널은 `formatErr`.

#### CF-14 · 압축/체크섬 선택폭 — 포맷 2종, 목적지 선택 없음, MD5/SHA-1 없음, 파일 저장 없음

- **심각도**: Low · **레이어**: BE + FE
- **현재 동작**: 압축 zip / tar.gz (`CompressDialog.tsx:19-22`), 레벨·암호·목적지(반대 패널) 없음. 체크섬 SHA-256/512 만, 클립보드 복사만.
- **상용 툴**: TC Alt+F5 포맷 6종·레벨·암호·대상·분할, DOpus 7z/zip/tar.xz, TC 체크섬 CRC32/MD5/SHA1/… + `.sfv/.md5` 저장·검증.
- **문제**: 배포물 검증엔 여전히 MD5/SHA-1 이 흔하고, 큰 폴더는 반대 패널로 바로 압축하고 싶다.
- **제안**: `CompressFormat` 에 `tar_xz|tar_zst|7z`(의존성 승인), `level`, `dest: here|other`; `ChecksumAlgo` 에 `md5|sha1|crc32`(원격 `md5sum` 등), "파일로 저장".

#### CF-15 · 권한 다이얼로그 — 특수 비트·현재 소유자 표시·디렉토리 전용 X 없음

- **심각도**: Low · **레이어**: BE + FE
- **현재 동작**: `mode & 0o777` 마스킹(`PermissionsDialog.tsx:68`) → setuid/setgid/sticky 불가. 소유자/그룹은 입력칸만(placeholder "unchanged") — 현재 값이 안 보인다. 재귀 시 파일에도 x 가 붙는다.
- **상용 툴**: WinSCP Properties(현재값 콤보, 특수 비트, "X for directories"), FileZilla 현재 owner.
- **문제**: 재귀 755 를 파일에까지 주는 실수 유도.
- **제안**: 4자리 8진수 + 특수 비트 체크박스; `Entry` 에 owner/group 이 오면 라벨 표시(NV-09); 재귀 "디렉토리에만 실행 비트".

#### CF-16 · 첫 실행 / 빈 상태 안내가 없음

- **심각도**: Low · **레이어**: FE
- **현재 동작**: 부팅은 세션이 없으면 양쪽 home 으로 끝. 웰컴/힌트/Ctrl+P·F1 안내 없음. 패널 빈 폴더/필터 불일치/로딩 문구는 있음.
- **상용 툴**: ForkLift/Transmit 첫 실행 연결 시트, Cyberduck 빈 상태 일러스트, VS Code Welcome.
- **문제**: 핵심 가치(같은 호스트 직접 복사, Ctrl+Z, 휴지통 기본)를 스스로 발견해야 한다.
- **제안**: 최초 1회 상태바 위 1줄 힌트, 또는 팔레트 빈 질의에 "시작하기" 그룹(호스트 연결, 설정, 치트시트).

#### CF-17 · 실행 취소 히스토리 — 항목별 되돌리기·위치 열기·토스트 Undo 없음

- **심각도**: Low · **레이어**: FE (+BE)
- **현재 동작**: 히스토리는 최근 100건 + "다음 Ctrl+Z" 배지 + Undo/Redo 버튼. 임의 항목 undo 미지원, 행 클릭/우클릭 없음. 완료 토스트에 "되돌리기" 없음.
- **상용 툴**: TC/DOpus 는 undo 자체가 없거나 제한적(→ duet 이 앞섬). DOpus 12 Undo 목록은 항목별.
- **문제**: 이미 우위인 영역이지만 100건이면 "3번 전 것만" 요구가 생긴다.
- **제안**: 완료 토스트 `Undo` 액션(CF-06); 행 우클릭 "위치 열기"; 항목별 undo 는 `undo_entry(id)` 후속.

#### CF-18 · 치트시트 — 제스처 키 문자열 미번역, 누락 제스처

- **심각도**: Low · **레이어**: FE
- **현재 동작**: `BUILTIN_GESTURES` 키 컬럼이 raw 영어(`ShortcutCheatsheet.tsx:20-31`). Shift+Space(폴더 크기), 사이드바 ⌘-클릭, 탭 가운데 클릭, 세그먼트 더블클릭 등 DESIGN 의 제스처가 빠져 있다.
- **상용 툴**: VS Code Keyboard Shortcuts Reference.
- **문제**: 치트시트가 실제 제스처 목록보다 작다.
- **제안**: 키 컬럼도 i18n 키로; 누락 제스처 추가.

#### CF-19 · 앱 런처 스트립 — 키보드/팔레트에서 접근 불가

- **심각도**: Low · **레이어**: FE
- **현재 동작**: 마우스 클릭/드래그/우클릭만(`AppLauncherStrip.tsx`), 팔레트 동적 커맨드에 런처 없음.
- **상용 툴**: DOpus 툴바 버튼 핫키, Raycast/Alfred 앱 실행 1급.
- **문제**: 키보드 1급 원칙 예외.
- **제안**: `dynamicCommands` 에 `app.launch:<id>` → 팔레트·keymap 바인딩 가능.

#### CF-20 · 검색 패널이 전역 드라이브 인덱싱을 노출하지만 제어 수단이 없음

- **심각도**: Low · **레이어**: BE + FE
- **현재 동작**: 파일명 모드에서 인덱스 진행("indexing drive… N")을 보여주지만 취소/일시정지/대상 드라이브/제외 경로 설정 없음.
- **상용 툴**: Everything 인덱스 대상 볼륨/제외, Spotlight Privacy.
- **문제**: 무엇을 얼마나 읽는지 사용자가 정할 수 없다.
- **제안**: 설정 "파일명 인덱스: 사용/제외 경로/재색인".

### 원격·SSH 연결 (17건)

호스트키 검증·자격증명 취급·원격 휴지통은 상용 SFTP 클라이언트보다 진지하다. 반면 "저장한 비밀번호" 가 재시작 후 쓰이지 않고(1줄 누락), 연결을 끊을 UI 가 없으며, 자동 재연결은 ssh-config + 키 인증 조합에서만 동작한다 — 가장 흔한 사용자(IP·비번 직접 입력)에게 약속이 지켜지지 않는다.

**잘 되어 있는 것 (상용 툴 동급 이상):**

- 호스트키 UX — 미지 호스트 TOFU 와 변경된 키를 명확히 구분, 변경 시 danger 밴드 + 확인 체크 전 교체 버튼 비활성, known_hosts 줄 백업 (`HostKeyPrompt.tsx`). 재연결은 절대 키를 학습/교체하지 않음.
- 자격증명 — 저장 비번은 백엔드가 vault 에서 직접 꺼내 쓰고 평문을 렌더러로 돌려보내지 않음, 사용 직후 zeroize. 상용 툴 중 이 수준으로 노출면을 줄인 곳은 드묾.
- 같은 호스트 복사 메시징 + unspecified IP 는 same-host 판정 제외 (`copy_strategy.rs:28-38`) 로 오판 방지.
- 원격 휴지통 + Undo + Put back — Cyberduck/Transmit/FileZilla 는 원격 삭제가 곧 영구삭제.
- 패널 내 연결 배너와 자리 복귀 재연결 (`ConnectionBanner.tsx`, pendingNav).
- Passwordless login 설정(ssh-copy-id 동등), 원격 미디어/PDF Range 스트리밍, 원격 검색 rg→grep 폴백, 원격 Places/Volumes(df), N-hop ProxyJump.

#### SS-01 · 저장된 비밀번호가 앱 재시작 후 사실상 못 씀 — vault 상태를 부트스트랩에서 한 번도 안 읽음

- **심각도**: High · **레이어**: FE (1줄) · ✔ 직접 검증 · **고침**: 부팅 시 vault 상태 refresh
- **현재 동작**: `stores/vault.ts:19-26` `refresh()` 호출처는 `vaultUnlock/vaultSet/vaultLock` 내부뿐. `App.tsx` 에 vault 참조 0건. 재시작 직후 store 는 `exists=false, unlocked=false` → `AdHocConnectDialog.tsx:341` "Unlock vault" 버튼 조건이 false 라 버튼 미표시, `:151-154` `savedPasswordAlias` 는 null → 백엔드 `resolve_password` 가 None → 키/agent 만 시도 → `AuthFailed`. "비번 저장" 기능이 같은 세션 안에서만 동작한다.
- **상용 툴**: Cyberduck keychain 자동, Termius vault 1회 unlock 후 자동, WinSCP 저장 비번 자동 로그인.
- **문제**: 기능이 있는데 "저장했는데 왜 또 물어보지" 를 반복 — 신뢰 하락.
- **제안**: 부트스트랩(`bootstrapSavedHosts` 옆)에서 `useVault.getState().refresh()`. 프리필 호스트에 저장 비번이 있고 vault 가 잠겨 있으면 Connect 시 `MasterPasswordDialog` 자동 → 접속 진행.

#### SS-02 · 연결 끊기(Disconnect) UI 가 전혀 없음

- **심각도**: High · **레이어**: FE · ✔ 직접 검증 · **고침**: 호스트 우클릭 '연결 끊기' + disconnectAlias
- **현재 동작**: 백엔드 `connection_close` (`commands/connection.rs:288-326`) 는 재연결 취소·임시 dir 정리까지 완비. 프론트 호출처는 `bindings.ts` 정의뿐, 실제 호출 0건. 사이드바 호스트 메뉴는 Connect / 표시명 / 태그만. 유일한 종료 수단 = 앱 종료. 그 사이 supervisor 는 계속 감시/재연결.
- **상용 툴**: Transmit 툴바 Disconnect, Cyberduck ⌘⇧D, WinSCP Session › Disconnect, FileZilla 툴바.
- **문제**: VPN 끊기 전/노트북 닫기 전/서버 점검 전에 세션을 정리할 수 없다. 세션이 쌓여도 정리 불가(SS-06).
- **제안**: 사이드바 호스트 우클릭 "연결 끊기"(connected 일 때), PathBar 호스트 칩 메뉴, 팔레트 "Disconnect: alias". 끊긴 뒤 탭은 이미 `ConnectionBanner` 경로로 "Disconnected + Reconnect" 가 뜬다.

#### SS-03 · 저장(ad-hoc) 호스트와 비번 인증 호스트는 자동 재연결이 절대 안 되고, 에러 메시지가 틀림

- **심각도**: High · **레이어**: BE + FE
- **현재 동작**: `connection_supervisor.rs:111-133` reconnect_loop 는 `load_ssh_hosts()` 후 alias 를 config 에서 찾는다. ad-hoc alias 는 `user@host:port` → config 에 없음 → 첫 시도에서 `final_failure("host alias removed from ~/.ssh/config")` — 배너 툴팁에 그대로 노출. 비번 인증 config 호스트도 비번 없이 `connect` → `AuthFailed` → 즉시 포기. 즉 자동 재연결은 ssh-config + 키/agent 조합에서만.
- **상용 툴**: WinSCP 저장 세션 자격증명으로 자동 재연결, Cyberduck keychain 재시도, FileZilla.
- **문제**: "끊겨도 알아서 복구" 약속이 가장 흔한 사용자(비번/IP 직접입력)에게 거짓이고, 메시지는 오도.
- **제안**: `ActiveConnection` 에 접속 시 사용한 `SshHostEntry` + `saved_password_alias` 를 보관하고 reconnect 가 그것을 사용(비번은 백엔드가 vault 에서 직접 — §5). 실패 사유를 `Error{ reason: enum }` 으로 구조화해 프론트가 "저장 비번 없음 → Reconnect 눌러 입력" 안내.

#### SS-04 · passphrase 걸린 개인키를 쓸 수 없음 — 프롬프트 부재 (Windows 는 agent 도 미지원)

- **심각도**: High · **레이어**: BE + FE
- **현재 동작**: `ssh/connection.rs:586-612` 가 `auth_publickey_on_handle(…, None)` 로 passphrase 없이 로드 → 실패 시 `AuthFailed`. fallback 은 비밀번호 인증이지 키 passphrase 가 아님. agent 는 Unix 전용(`:403-408`). 다이얼로그 라벨 "Password (optional — fallback if key/agent fails)" 는 passphrase 를 언급하지 않는다.
- **상용 툴**: WinSCP/PuTTY passphrase 프롬프트, Cyberduck 프롬프트+keychain, Termius passphrase 저장.
- **문제**: 암호화 키를 쓰는 사용자, 특히 Windows 사용자는 키 인증 자체가 불가능. 에러도 "AuthFailed" 라 원인을 못 찾는다.
- **제안**: `load_secret_key` 실패를 `DuetError::KeyEncrypted { path_hint }` 로 구분 → passphrase 입력칸(§5 완화 조건 동일) 재시도 → `load_secret_key(path, Some(pp))`. 옵션으로 vault 저장.

#### SS-05 · 접속 중 취소/타임아웃 없음, 실패 시 raw `kind` 노출, 닫은 다이얼로그가 나중에 패널을 바꿈

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: `TcpStream::connect` (`connection.rs:666, 352`) 에 타임아웃 없음 → OS 기본(수십 초). 다이얼로그는 버튼만 "Connecting…", Esc 로 닫아도 IPC 는 계속 → 성공하면 `:74-86` 이 `onConnected` 를 호출해 패널이 바뀐다. 에러 박스는 `error.kind` 원문("ConnectionFailed")을 제목으로, 메시지는 자체 `formatError` 라 "(os error 61)" 미제거.
- **상용 툴**: Cyberduck 실패 시트 + Try Again, VS Code Remote Retry/Cancel 배너, FileZilla 타임아웃 카운트다운 + Cancel.
- **문제**: 죽은 IP 에 잘못 접속하면 수십 초 갇힌다; 취소했다고 생각했는데 뒤늦게 패널이 원격으로 바뀐다.
- **제안**: `tokio::time::timeout`(기본 15-20s) + `CancellationToken` 기반 `connection_cancel`. Connecting 에 Cancel, 닫힌 뒤 도착한 결과는 무시. `formatErr` 통일 + refused/timed out/DNS 힌트.

#### SS-06 · 같은 호스트를 더블클릭할 때마다 새 세션 — 재사용 없음, 세션 목록도 없음

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `onHostActivate` (`App.tsx:1462-1464`) → 다이얼로그 → 항상 `connectionOpen`. `liveByAlias` 재사용은 즐겨찾기/북마크 경로만. 사이드바 점은 alias 당 하나라 세션이 3개여도 표시 없음. 새 탭은 location 복제로 같은 connection 재사용(OK).
- **상용 툴**: Transmit/ForkLift 같은 서버 재사용, WinSCP Duplicate session 은 명시적.
- **문제**: 서버 측 세션·캐시·temp dir 이 세션마다 중복. SS-02 와 합쳐지면 정리 불가.
- **제안**: `liveByAlias(alias)` 가 있으면 더블클릭은 그 연결로 홈 이동만, 우클릭에 "새 세션으로 연결"; alias 옆 `×N` 배지 + 세션별 끊기.

#### SS-07 · 재연결 배너에 시도 횟수·카운트다운·취소가 없고, 그 동안 작업 실패 메시지가 내부 문자열

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: supervisor 가 시도마다 `Connecting` 만 emit(`connection_supervisor.rs:94-101`), 백오프 1→30s 6회. 배너는 "Connecting to X…". 재연결 중 목록/복사는 `no connection: <alias:uuid>` 로 실패.
- **상용 툴**: WinSCP "Reconnecting in 12 s… attempt 2" + Cancel, FileZilla, VS Code Remote.
- **문제**: 1분 넘게 스피너만 보이고 뭘 기다리는지, 그만둘 수 있는지 모른다.
- **제안**: `Connecting { attempt, max, next_retry_ms }`; "재연결 중 2/6 · 8초 후 재시도 [취소]", 재연결 중 목록 흐리게.

#### SS-08 · `~/.ssh/config` 목록이 시작 시 1회 로드 — 새로고침 없음

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `useSshHosts.ts:8-9` 주석대로 후속 과제. Hosts 섹션 액션은 `+` 뿐. 백엔드는 접속마다 재파싱하므로 목록만 stale. Places 섹션엔 ⟳ 가 있어 일관성도 깨진다.
- **상용 툴**: VS Code Remote 피커 열 때 재파싱, Termius 동기화.
- **문제**: config 편집 후 앱 재시작 필요.
- **제안**: Hosts 헤더 ⟳ + 윈도우 포커스 복귀 시 재로드. 후속으로 `keymap_watcher` 패턴의 파일 watcher.

#### SS-09 · 호스트별 설정이 거의 없고, 저장 호스트 "편집" 이 접속과 결합돼 있음

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: `SavedHost` = alias/host/port/user/key_path. ad-hoc ProxyJump 미지원. 초기 경로는 home→`~`→`/` 고정, 호스트별 기본 경로 없음. keepalive 15s×3 고정. 편집은 "Connect / Edit…" 로 열리지만 Save 체크 기본 off 이고 저장은 접속 성공 후에만(`AdHocConnectDialog.tsx:187-215`) → 접속 없이 host/port/key 수정 불가.
- **상용 툴**: Cyberduck 북마크(경로·인코딩·노트), WinSCP 고급 탭, Termius 태그·그룹·점프호스트.
- **문제**: 오프라인에서 IP 바뀐 호스트를 못 고친다. 매번 홈으로 떨어져 즐겨찾기를 또 눌러야 한다.
- **제안**: `SavedHost` 에 `initial_path`, `proxy_jump`, `note`; "Edit host" 를 접속과 분리(저장 즉시).

#### SS-10 · 원격 편집 라운드트립 — 우클릭 전용(F4 미바인딩), 업로드 피드백 없음, 서버측 변경 감지 없음

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: 진입점은 컨텍스트 메뉴 "edit-remote" 뿐(`entryMenu.tsx:246-249`), `commands.ts` 에 F4 없음. `ssh_edit_open` 은 전체 다운로드 → `opener::open`(OS 기본앱; `ext_app_overrides` 미적용) → 1.5s mtime 폴링 → 업로드 성공/실패를 `tracing` 로만(`edit_session.rs:73-81`). 원격 파일이 그 사이 바뀌었는지 확인 없이 덮어씀. 연결이 끊기면 watch 가 조용히 종료 → 이후 저장분 유실을 모른다.
- **상용 툴**: WinSCP(에디터 설정, 업로드 알림, 서버 변경 경고), Cyberduck Edit With + 전송 진행, Transmit.
- **문제**: "저장했는데 서버에 반영됐나?" 를 확인할 길이 없다. 끊김 후 저장은 silent loss.
- **제안**: `edit-session-event {uploaded|failed|stale|ended}`, 업로드 전 원격 mtime 비교(stale → 덮어쓰기/둘 다 유지), `ext_app_overrides` 적용; F4 바인딩(원격이면 edit-remote), TasksBar "편집 중 N개", 토스트.

#### SS-11 · 원격 휴지통 — 기본 안전은 훌륭하나 비우기/정리 수단이 없고 목록이 raw

- **심각도**: Med · **레이어**: BE + FE
- **현재 동작**: 삭제 확인에 원격 휴지통 안내, 사이드바 Trash 가 소스 인식, Put back 지원. 그러나 `trash_list/purge/empty` 는 로컬 전용(`commands/trash.rs:61-120`) → 원격은 `<batch>/<절대경로>` 트리를 그대로 보고, 비우기·오래된 batch 정리 없음.
- **상용 툴**: Cyberduck/Transmit/FileZilla 는 원격 휴지통 자체가 없음 → duet 의 차별점. 관리 기능이 없으면 서버 디스크가 조용히 찬다.
- **문제**: 몇 달 뒤 `~/.duet-trash` 가 수십 GB; 사용자는 SSH 셸에서 직접 `rm -rf` 해야 한다(앱 철학과 정반대).
- **제안**: `remote_trash_list(conn)` 로 batch 를 (원본 경로, 삭제시각, 크기)로 평탄화해 `trashView.ts` 재사용; `remote_trash_purge(conn, batch_ids | older_than_days)` + 단어 타이핑; 설정 "N일 지난 원격 휴지통 정리 제안".

#### SS-12 · 팔레트/단축키로 ssh-config 호스트에 접속 불가 — Ctrl+K / Ctrl+Shift+K 미구현, 접속이 3단계

- **심각도**: Med · **레이어**: FE
- **현재 동작**: `dynamicCommands.ts:36-41` 은 `useSavedHosts` 만 등록 — config 호스트(`useConnections.hosts`)는 팔레트에 없음. `commands.ts` 에 `connection.*` 커맨드·Ctrl+K 없음(DESIGN 키 표엔 존재). config 호스트 더블클릭 → `ConnectionDialog` → Connect 클릭/Enter. `HostItem` 은 어느 패널에 붙어 있는지 배지 없음.
- **상용 툴**: ForkLift ⌘K Connect 패널, VS Code Remote 호스트 피커, Termius 퀵서치·즉시 접속, Cyberduck/Transmit 더블클릭 즉시 접속.
- **문제**: 키보드 1급 원칙 위반 — 원격 접속만 마우스 필수. 호스트가 가장 자주 하는 동작인데 매번 다이얼로그.
- **제안**: config 호스트도 dynamic command(별명 반영), `connection.quickConnect`(Ctrl+Shift+K), `connection.open`(Ctrl+K → Connection 카테고리 팔레트). 단일 클릭/Enter 로 즉시 접속 시도, 실패 시에만 다이얼로그; 연결된 호스트 행에 L/R 배지.

#### SS-13 · sudo 승격 — "되돌릴 수 없음" 미고지, 탐색(읽기)엔 미적용

- **심각도**: Low · **레이어**: FE
- **현재 동작**: PermissionDenied → "Retry with sudo?" → passwordless probe → 비번 다이얼로그(`App.tsx:1246-1313`, `core/sudo.rs`). `sudo.rs:9` "v1: undo 없음" 인데 확인문에 언급 없음(§4 소지). root 전용 디렉토리 탐색은 PermissionDenied 그대로.
- **상용 툴**: WinSCP "sudo su -" 셸 옵션(탐색 포함).
- **문제**: 되돌릴 수 없는 작업을 사용자가 모른 채 승인한다.
- **제안**: sudo 확인문에 "sudo 로 실행한 작업은 Ctrl+Z 로 되돌릴 수 없음" 한 줄. sudo listing 은 별도 설계.

#### SS-14 · vault 관리 UI 없음 — 잠그기/저장 비번 삭제/고아 비밀

- **심각도**: Low · **레이어**: FE (+BE cascade)
- **현재 동작**: `vaultLock/vaultRemove` 미사용. `removeSavedHost` 와 백엔드 `saved_hosts.rs` 는 vault 를 건드리지 않음 → 호스트 삭제 후 암호화된 비번이 남는다. "비번도 저장" 체크박스는 Save host + 비번 입력 시에만 노출.
- **상용 툴**: Termius 비번 forget, Cyberduck keychain 항목 삭제.
- **문제**: 저장된 비밀을 보거나 지울 방법이 없다.
- **제안**: 설정 › Connections 에 vault 잠금, alias 별 저장 여부(`vaultHas`)와 삭제; 호스트 삭제 시 `vaultRemove` 연쇄.

#### SS-15 · 상태·오류 표시 디테일 — 오류 사유를 마우스로 볼 수 없음, 접속 성공 토스트, 내부 함수명 노출

- **심각도**: Low · **레이어**: FE
- **현재 동작**: 사이드바 오류 삼각형은 `aria-label` 만, 행 `title` 은 호스트 정보 → 사유를 볼 수 없다. 접속 성공마다 토스트(`App.tsx:1551`). `toast.sshHomeFailed` 가 "ssh_home_directory failed" 노출.
- **상용 툴**: —
- **문제**: 실패 원인을 찾으려면 다시 시도해야 한다.
- **제안**: 오류 행 `title` 에 사유, 성공 토스트 제거(패널 전환이 곧 피드백), 문구 정리.

#### SS-16 · 터미널 열기가 로컬 전용 — 원격은 §9(시스템 ssh 호출 금지)와 충돌하는 결정 사항

- **심각도**: Low · **레이어**: 결정 필요
- **현재 동작**: `commands/system.rs:648-664` 원격은 `NotSupported`; 메뉴는 로컬일 때만 노출이라 혼란은 없다.
- **상용 툴**: Cyberduck Open in Terminal, WinSCP Open in PuTTY, ForkLift, Termius.
- **문제**: OS 터미널에서 `ssh alias` 를 띄우는 방식은 §9 에 저촉될 수 있다. 대안은 russh 채널 위 in-app 터미널(큰 작업).
- **제안**: 사용자 결정: (a) §9 예외로 "터미널 앱에 `ssh alias` 명령 전달" 허용, (b) in-app 터미널 로드맵, (c) 현행 유지.

#### SS-17 · ssh_config 병합 규칙 가장자리 — hostname 기준 중복은 둘 다 표시, 다중 패턴은 첫 alias 만

- **심각도**: Low · **레이어**: FE
- **현재 동작**: alias 동일 시 config 우선·저장본 숨김(합리적). hostname 기준 중복(config `prod`=10.0.0.5 와 저장 `root@10.0.0.5:22`)은 둘 다. `Host a b` 는 첫 alias 만(`ssh/config.rs:80-86`). `Include`/`Match` 지원은 ssh2-config 의존 — 미확인.
- **상용 툴**: —
- **문제**: 같은 서버가 두 줄로 보인다.
- **제안**: hostname+user+port 일치 시 "config 와 같은 서버" 배지 또는 숨김 옵션.

## 방법과 한계

- 코드 리딩만 — 앱을 실행하거나 실기에서 재현하지 않았다. file:line 은 리뷰 시점의 main(a1480b8) 기준.
- 영역별 리뷰 5건을 병렬 수행한 뒤 중복을 합치고 심각도를 재조정했다. High 항목 중 15건은 리드가 코드 경로를 직접 다시 읽어 확인(✔). 나머지는 영역 리뷰의 인용에 의존하므로 착수 전 해당 줄을 한 번 더 볼 것.
- 상용 툴의 동작은 일반 지식에 기반한다. 버전에 따라 세부가 다를 수 있다.
- 심각도는 "일상 사용에서 얼마나 자주·크게 걸리는가" 기준의 판단이지 측정값이 아니다.
- 범위 밖: 성능, 접근성 전반, Windows 셸 통합 세부, 압축/비교/3-way 다이얼로그의 기능 완성도.
