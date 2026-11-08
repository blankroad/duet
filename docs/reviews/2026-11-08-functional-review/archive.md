# archive 점검 최종 보고

## 요약

- 해제(extract)는 대체로 튼튼하다: 충돌 백업 → undo 복원, 손상 파일 롤백, 일부 암호 zip, 65,600 항목 zip64, 7z 암호·경로 방어 모두 정상. 문제는 **새 tar 엔진의 보안 구멍**, **압축 만들기·다시 묶기(repack)의 데이터 안전**, **zip 의 Windows/한국어 호환** 세 갈래에 몰려 있다.
- **P1 4건**:
  1. **archive-01** 새 `tar_unpack.rs`: 악성 tar 를 풀거나 **더블클릭으로 안을 보기만 해도** 해제 폴더 밖에 파일을 만들거나 덮어쓰거나 읽어 온다.
  2. **archive-02** 아카이브 안 하위 폴더에서 "Update archive" 를 누르면 그 하위 폴더 내용만으로 원본이 다시 만들어진다.
  3. **archive-03** 압축·repack 이 실패하거나 취소되면 원본이 `.bak` 이름에 갇히고, 원래 이름엔 불완전하지만 열리는 zip 이 남는다. undo 도 안 된다.
  4. **archive-04** 한국어 Windows 에서 만든 zip(UTF-8 표시 없는 CP949 이름)의 한글 이름이 `╟╤▒█.txt` 처럼 깨진다. 사용자가 겪은 "Windows 압축 문제" 의 가장 유력한 원인이다.
- 그다음으로 사용자 Windows 문제와 직접 관련된 것: **archive-06**(7-Zip·반디집 등의 BZip2/LZMA/Zstd 방식 zip 은 아예 안 풀림), **archive-07**(zip·7z 에는 tar 처럼 Windows 링크·금지 이름 처리가 없음 — 기기 확인 필요).
- 판정 수: P1 4 / P2 13 / P3 17 (총 34). 모든 P1·P2 는 실행으로 재현했다(Windows 전용 2건은 코드 추적 + 기기 확인 필요). 교차 검토에서 반박 0건.

## 점검 범위

| ID   | 기능                              | 결과                                                                                        | 확인 방법                                           | 확인한 사람               |
| ---- | --------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| C-01 | 포맷 판정·이름 도출               | 개선(archive-30)                                                                            | Rust `lead_split_volume_names`                      | lead                      |
| C-02 | zip 압축 방식                     | 이슈 archive-06                                                                             | python 픽스처(BZip2/LZMA/Zstd) 실행, XZ/PPMd 분기   | sol → opus 재확인         |
| C-03 | zip 이름 인코딩                   | 이슈 archive-04 (0x7075 Unicode extra 는 OK)                                                | 직접 바이트 zip(CP949·SJIS·다른 이름) 해제·browse   | sol → opus 독립 재현      |
| C-04 | zip Windows 위험·암호/비암호 차이 | 이슈 archive-07·17·18, 경로 탈출은 OK                                                       | 코드 추적(zip-2.4.2) + macOS 재현                   | sol → opus 재추적·보정    |
| C-05 | 암호 흐름(ZipCrypto/AES/7z/rar)   | OK + archive-20·34                                                                          | Rust 재현 + FE 코드 추적(재시도·§5 clear)           | opus → sol(20)            |
| C-06 | 7z                                | OK (경로 방어·빈 폴더·암호 6조합·손상) + archive-17                                         | sevenz_rust2 로 생성한 픽스처 실행                  | sol, opus(대소문자)       |
| C-07 | rar                               | 검증 필요 (archive-19), 금지 이름은 C++ unrar 가 치환                                       | 코드 추적만 (rar 픽스처 생성 불가)                  | sol                       |
| C-08 | 단일 파일 gz/bz2/xz/zst           | 롤백 OK, archive-28·29                                                                      | Rust 재현                                           | lead → sol 독립 재현      |
| C-09 | tar_unpack 보안·정확성            | **이슈 archive-01(P1)**·08·09·17. 링크 뒤 폴더/일반 파일, FIFO, 긴 이름, PAX, 절대경로는 OK | Rust 재현(tempdir)                                  | sol → opus 독립 재현·확장 |
| C-10 | 해제 흐름(충돌·롤백·취소·중복)    | 충돌·롤백 OK, 이슈 archive-09·14                                                            | `extract_execute`+journal+undo 실행                 | opus, sol                 |
| C-11 | browse(내부 보기)                 | 이슈 archive-15·23·25                                                                       | Rust + Vitest(panes store)                          | opus, lead(15 재확인)     |
| C-12 | 압축 만들기                       | 이슈 archive-03·10·12·13·22·24                                                              | Rust 재현(sparse 4GiB 포함)                         | opus → sol                |
| C-13 | repack                            | 이슈 archive-02·03·11·12 (보존 표는 아래 "개선 제안")                                       | Rust round-trip                                     | opus → sol                |
| C-14 | 원격 명령 조립                    | 인용 OK, 이슈 archive-05·27·31·32                                                           | Rust 명령 문자열 + 로컬 Info-ZIP/bsdtar + 코드 추적 | lead → sol                |
| C-15 | 알림·오류 문구                    | 이슈 archive-16·26                                                                          | Vitest(`explainError`, `describeArchiveNotice`)     | opus, lead 재실행         |
| C-16 | FE 메뉴·노출                      | 이슈 archive-02(버튼)·21·24                                                                 | 코드 추적                                           | opus                      |
| C-17 | Windows 크로스 컴파일             | OK (clippy `x86_64-pc-windows-gnu` exit 0), archive-33                                      | clippy + 코드 추적                                  | lead                      |

## 이슈 대장 (심각도순)

### P1

**archive-01 [P1] [bug/보안] tar 하드링크 복사 폴백이 이미 만든 심볼릭 링크를 따라 해제 폴더 밖 파일을 생성·덮어쓰기·읽기** — 확인됨, 교차 동의

- 사용자 증상: 받은 tar/tar.gz/tgz/tar.bz2/tar.xz/tar.zst 를 **풀거나 더블클릭으로 안을 보기만 해도** 해제 폴더 밖의 파일이 덮어써지거나 새로 생긴다. 바깥 파일 내용이 해제 결과로 복사되기도 한다. 해제는 "성공" 으로 끝나고 알림은 없다. 링크 대상이 상대·절대 모두 가능하다. 그래서 `~/Downloads/x` 에서 `../../Library/LaunchAgents/*.plist`·`~/.zshrc`·`~/.config/autostart` 같은 자동 실행 위치에 쓸 수 있다(추론. 실행은 tempdir 로만 확인).
- 재현: sol `sol_tar_hardlink_destination_symlink_cannot_overwrite_outside`(덮어쓰기), `sol_tar_hardlink_fallback_cannot_copy_outside_source`(읽기). opus `opus2_hardlink_dst_symlink_overwrites_outside_via_extract_execute`(앱 경로), `opus2_hardlink_src_symlink_leaks_outside_via_extract_execute`(상대 링크), `opus2_hardlink_dst_dangling_symlink_creates_outside_file`(**대상 없는 바깥 경로에 새 파일 생성**), `opus2_browse_hardlink_attack_writes_outside`(browse 만으로 발생).
- 원인: `core/tar_unpack.rs:68-81` 은 `hard_link` 가 **어떤 이유로든** 실패하면 `std::fs::copy` 를 시도한다. copy 는 소스·대상 링크를 모두 따라간다. `refuse_through_link`(116-133)는 마지막 조각을 검사하지 않는다. 대상 이름을 먼저 차지하면 EEXIST 로 폴백이 일어난다.
- 범위: tar 계열 로컬 해제·browse. zip·7z·rar·원격은 이 코드를 쓰지 않는다.
  - Windows 비관리자: 링크 생성이 1314 로 건너뛰어져 불성립(코드 추적).
  - Windows 개발자 모드·관리자: 소스 쪽 변형은 성립 가능성이 높다(기기 확인 필요).
  - hard_link 가 성공하는 경로는 macOS 에서 안전하다(링크 자체를 하드링크, `opus2_hardlink_success_on_symlink_src`). Linux 도 같을 것으로 본다(확신도 중간).
- 수정안 (S~M): 아래 셋을 모두 적용해야 한다(opus 검토 — 이 조합이 세 시나리오를 모두 막고, ① 단독으로는 exFAT 류에서 소스 변형이 남는다).
  - ① 폴백은 "하드링크 미지원" 오류(EXDEV/EPERM/Unsupported)일 때만 쓴다.
  - ② 소스·대상의 **마지막 조각까지** 심볼릭 링크면 거부한다.
  - ③ 복사는 `create_new`(O_EXCL)로 한다.
  - 회귀 방지: 같은 이름 재등장은 대상이 폴더가 아닐 때 `remove_file`(링크 자체만 삭제) 후 hard_link 한다.
- 교차 검토: opus 동의 + 범위 확장(생성 변형·browse). 심각도 P1 유지.

**archive-02 [P1] [bug/데이터] browse 하위 폴더에서 "Update archive" → 하위 폴더 내용만으로 원본 재생성** — 확인됨, 교차 동의

- 증상: `data.zip` 을 열고 `docs/` 로 들어가 파일을 고친 뒤 "Update archive" 를 누르면, `data.zip` 이 `docs/` 안 항목만 **최상위로** 담은 아카이브가 된다. 나머지 항목은 사라진다. 확인 창은 "N개 항목을 다시 압축" 만 말해 알아챌 수 없다. 원본은 `.bak.<시각>` 에 남고 Ctrl+Z 로 복구할 수 있다.
- 재현: `opus_repack_from_subfolder_keeps_other_entries`, `sol2_subfolder_repack_zip_and_targz`(zip·tar.gz 모두 `["z.txt"]` 만 남음).
- 원인:
  - `src/App.tsx:1270` `fsRepackPlan(tab.location, …)` — `tab.archive.root` 가 아니라 현재 폴더를 보낸다.
  - 버튼 노출 `src/components/pane/Pane.tsx:145-150` 은 하위 폴더도 허용한다.
  - 백엔드 `core/archive.rs:1039` 는 루트인지 검증하지 않는다.
- 수정안: FE 에서 `archive.root` 를 보낸다(S). BE 는 browse token 루트가 아니면 거부한다(S~M). 확인 창에 원본 이름과 루트 기준 항목 수를 보여 준다.

**archive-03 [P1] [bug/데이터] 압축·repack 이 실패·취소되면 롤백 없음** — 확인됨, 교차 동의 (+F-sol-10 취소 계기 병합)

- 증상: 같은 이름이 있으면(repack 은 항상 해당) 원본이 `.bak.<시각>` 으로 옮겨진 채 남는다. 원래 이름에는 **실패 지점까지만 든, 정상처럼 열리는 zip** 이 남는다. journal 기록이 없어 Ctrl+Z 도 안 된다. 충돌이 없으면 부분 파일만 남는다.
- 계기(모두 실행 확인): 대상 없는 심볼릭 링크(배포용 tar.gz 의 `current -> releases/vN` 흔함), 읽기 불가 파일, 4GiB 초과(archive-13), 순환 링크, 시작 직후 취소.
- 재현: `opus_compress_failure_restores_conflicting_archive`, `opus_repack_targz_with_dangling_symlink`, `sol2_failed_targz_conflict_dangling_link_no_rollback`, `sol2_failed_zip_permission_leaves_openable_partial`, `sol2_pre_cancelled_compress_moves_original_without_journal`.
- 원인: `core/archive.rs:947-962` 백업 이동 뒤 `:965-990` 의 `?`·취소 반환에 복원 코드가 없다. extract(296-306)에는 있다.
- 수정안: 최소안은 실패·취소 시 부분 결과를 지우고 백업을 되돌리는 것(S). 권장안은 `<dest>.part` 에 쓰고 성공 시 rename 하는 것이다 — 원본이 끝까지 제자리에 있고 원격도 같은 방식으로 맞출 수 있다(M).

**archive-04 [P1, R1 P2→lead 상향, opus 동의] [bug/Windows·한국어] UTF-8 표시 없는 CP949·Shift-JIS zip 이름이 CP437 로 깨짐** — 확인됨

- 증상: `보고서 2024/결과.xlsx` → `║╕░φ╝¡ 2024/░ß░·.xlsx`, `한글.txt` → `╟╤▒█.txt`. 내용은 풀리지만 폴더·파일 이름을 알아볼 수 없다. 해제와 browse 모두 해당한다.
- 재현: `sol_zip_cp949_names`, `sol_zip_sjis_names`, `opus2_zip_cp949_names_extract_and_browse`. 대조로 Info-ZIP Unicode Path extra(0x7075)가 있는 zip 은 정상(`sol_zip_unicode_extra`).
- 원인: zip-2.4.2 `read.rs:1313-1315` 는 플래그 11 이 없으면 CP437 로 해석한다. 앱은 `name_raw` 를 쓰지 않는다.
- 상향 근거(확신도 중간): 한국어 Windows 탐색기·국내 압축 도구가 플래그 없는 OEM(CP949) 이름을 쓰는 사례가 흔하다(`unzip -O cp949` 관행 등, opus-2 조사). Windows 11 이 UTF-8 로 바뀌었다는 공식 근거는 찾지 못했다.
- 수정안 (M):
  - 플래그 없음 + 이름이 ASCII 아님 + UTF-8 로도 유효하지 않음 + CP949 로 유효하면 → CP949 로 해석(또는 사용자 선택). ASCII 만이면 그대로.
  - CP949 디코더(`encoding_rs` 등)는 §6 승인 대상이다.
- 기기 확인: 한국어 Windows 10/11 탐색기 "보내기 → 압축(zip) 폴더" 결과를 `unzip -Z -v` 로 플래그 11·이름 바이트 확인.

### P2

| ID         | 종류               | 제목                                                           | 사용자 증상                                                                                                                                                                            | 근거·재현                                                                                                                                                                                          | 원인                                                                                                                                                                                                     | 수정안·비용                                                                                                                          | 상태 / 교차                                                                    |
| ---------- | ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------- |
| archive-05 | bug/데이터·Windows | Windows PC 에서 원격 아카이브 repack 시 백업 없이 덮어씀       | 서버 `x.tar.gz` 를 Update 하면 `.bak` 없이 덮어써지고 Ctrl+Z 실패. `.zip` 은 Info-ZIP `zip -r` 이 **갱신**이라 browse 에서 지운 항목이 남음                                            | `lead_repack_plan_uses_fs_join`, `sol2_repack_join_independent_sentinel_and_zip_update`(지운 항목 잔존 실행 확인)                                                                                  | `archive.rs:1044` PathBuf::join → `/home/u\x.zip`. SFTP stat(`fs/ssh.rs:652` `\` 보존) NotFound → 백업 생략. exec 인용(`copy_strategy.rs:60`)은 `\`→`/` 로 실제 원본에 씀. `archive.rs:769` 도 같은 패턴 | `fs.join`/`posix_join` 사용 (S)                                                                                                      | 확인됨(코드·TestFs)·기기 확인 필요 / sol 동의                                  |
| archive-06 | improvement        | BZip2/LZMA/Zstd/XZ/PPMd 방식 zip 해제·browse 불가              | 7-Zip·반디집 등에서 방식을 바꾼 zip 이 "지원 안 하는 압축 방식" 으로 실패(문구는 적절)                                                                                                 | `sol_zip_bzip2/lzma/zstd`                                                                                                                                                                          | `Cargo.toml:49` feature. 이미 알려진 제한(주석)                                                                                                                                                          | zip feature 활성화 검토 — bzip2 버전 차이·xz2(C) 빌드, PPMd 는 버전 업 필요 (M~L, §6)                                                | 확인됨 / opus 동의                                                             |
| archive-07 | bug/Windows        | zip·7z 에 tar 와 같은 Windows 처리 없음                        | 링크가 든 zip(맥·리눅스 `zip -y`)은 비관리자 Windows 에서 1314 로 **해제 전체 실패**. 금지 이름은 셋으로 갈림(opus 보정): `?\*<>                                                       | "`→ 전체 실패,`CON`·끝의 점 → 그 이름으로 생성(탐색기로 다루기 힘듦), `:` → 대체 데이터 스트림으로 **조용히 숨겨짐**. canonicalize 를 못 하는 드라이브(RAM 디스크·일부 네트워크)에서 zip 해제 실패 | 코드 추적 zip-2.4.2 `read.rs:868,918,922,451-488`, sevenz `util/decompress.rs:197-215`, 암호 zip 은 `archive.rs:530-542`                                                                                 | tar 만 `entry_name::sanitize_local_name`·`links::is_link_not_permitted` 사용                                                         | 포맷 공통 항목 단위 해제 계층(이름 치환·링크 skip·보고)으로 zip·7z 를 옮김 (M) | 기기 확인 필요 / opus 동의+보정 |
| archive-08 | bug                | 읽기 전용 폴더(0555/0500)가 든 정상 tar 해제 실패              | Go 모듈·일부 소스 tarball 이 "권한이 없습니다" 로 실패. bsdtar 는 같은 파일을 정상 해제                                                                                                | `sol_tar_readonly_directory_children`, `opus2_tar_readonly_dirs_0500_and_nested_0555`                                                                                                              | `tar_unpack.rs:84` 가 폴더 권한을 즉시 적용                                                                                                                                                              | 폴더 권한·시각은 끝에 역깊이 순으로 적용 (M)                                                                                         | 확인됨 / opus 동의                                                             |
| archive-09 | bug/데이터         | 해제 실패 롤백이 실패하면 기존 폴더가 `.bak` 에 남고 안내 없음 | 기존 `site/` 가 `site.bak.…` 으로 남고 원위치엔 부분물. 오류는 "권한이 없습니다" 뿐, 백업 위치 안내·undo 없음 → 사용자가 `.bak` 을 지울 위험                                           | `sol_tar_readonly_failure_restores_conflicting_destination`, `opus2_extract_rollback_failure_strands_backup`                                                                                       | `archive.rs:301,303` `let _ =` 로 실패 무시                                                                                                                                                              | 롤백 실패 시 "기존 폴더는 `<backup>` 에 보존" 을 오류에 포함(S). 내부 생성물은 쓰기 권한을 되돌린 뒤 정리(S). journal 복원 엔트리(M) | 확인됨 / opus 동의(P1 경계 의견)                                               |
| archive-10 | bug                | 압축이 심볼릭 링크를 따라감                                    | 대상 없는 링크가 하나라도 있으면 압축·repack 전체 실패 → archive-03. 순환 링크는 32단계 복사 후 ELOOP. 링크는 복사본이 됨. 폴더 밖을 가리키면 바깥 내용까지 담김(코드상)               | `opus_compress_zip/targz_symlink_loop`, `sol2_file_symlink_and_dangling_both_formats`                                                                                                              | zip `archive.rs:1127` `metadata`. tar `tar::Builder` 기본 `follow=true`(`:1092`)                                                                                                                         | tar `follow_symlinks(false)`(S), zip 은 `symlink_metadata`+`add_symlink`(S~M)                                                        | 확인됨 / sol 동의                                                              |
| archive-11 | bug/보안           | 암호 zip 을 repack 하면 암호 없는 zip 이 됨                    | AES·ZipCrypto 모두 결과 zip 이 평문. 안내 없음                                                                                                                                         | `opus_repack_encrypted_zip_stays_encrypted`, `sol2_zipcrypto_repack_removes_encryption`                                                                                                            | `archive.rs:1082-1083` 암호 옵션 없음. browse 암호는 버려짐                                                                                                                                              | 단기: plan 에 `drops_encryption` → 확인 창 경고(S). 장기: 암호 재입력 후 AES repack(M)                                               | 확인됨 / sol 동의                                                              |
| archive-12 | bug                | duet 이 만든 zip: 시각 1980-01-01, 실행 비트 없음              | 압축·repack 한 zip 의 모든 날짜가 1980, 스크립트 0644. repack 은 주석·Stored 방식도 잃음                                                                                               | `opus_compress_zip_keeps_mtime/exec_bit`, `sol2_zip_metadata_compared_to_targz`(tar.gz 는 보존)                                                                                                    | zip `time` feature 없음 + `add_to_zip` 이 mtime/권한 미설정                                                                                                                                              | 파일마다 `last_modified_time`·`unix_permissions` 지정 (S)                                                                            | 확인됨 / sol 동의                                                              |
| archive-13 | bug                | 4GiB 이상 파일 zip 압축 실패                                   | 끝까지 읽은 뒤 "Large file option has not been set" (영어 원문) → archive-03 경로                                                                                                      | `opus_compress_zip_over_4gib_file`(sparse, 8초), zip `write.rs:589-597`                                                                                                                            | `large_file(true)` 미설정                                                                                                                                                                                | 크기 ≥ u32::MAX 면 `large_file(true)` (S)                                                                                            | 확인됨 / sol 동의                                                              |
| archive-14 | bug                | 해제·압축 도중 취소 무효                                       | "취소됨" 이 뜬 뒤 끝까지 진행하고 Completed·journal 까지 기록. 그동안 로컬 FIFO 큐가 막혀 복사·이동 대기                                                                               | `sol2_cancel_after_zip_io_started_still_succeeds`(FIFO 로 결정적 재현), `task_queue.rs:160-166,263-274`                                                                                            | 취소 확인이 시작 전 1회(`archive.rs:265,965`). blocking 작업에 토큰 미전달. 큐가 Cancelled 뒤 Completed emit                                                                                             | 항목마다 토큰 확인 → Cancelled + 롤백(M). 큐 finalize 에서 취소 상태 존중(S)                                                         | 확인됨 / sol 동의                                                              |
| archive-15 | bug                | 아카이브 안 아카이브: 안쪽에서 나오면 바깥 문맥 사라짐         | 임시 경로(`…/duet-archive/<token>/content/sub`)가 그대로 보인다. "위로" 가 시스템 temp 로 올라간다. 바깥 아카이브의 Update 버튼이 사라진다. 세션 복원 시 reap 된 경로를 연다           | Vitest `archive-context` (`it.fails archive-15`)                                                                                                                                                   | `stores/panes.ts:575-578`, `App.tsx:567-576` 문맥 덮어쓰기(스택 없음)                                                                                                                                    | `ArchiveBrowse.parent` 스택(M)                                                                                                       | 확인됨 / lead 동의                                                             |
| archive-16 | ux                 | 아카이브 오류 일부가 영어 원문·엉뚱한 안내                     | 원격 AES zip(unzip 81) → "LZMA 등 방식 미지원·7-Zip 으로" (실제는 서버 unzip 이 AES 불가 → "내 PC 로 복사해 풀기" 가 맞음). 4GiB·ELOOP·빈 repack·rar 경로 탈출·이름에 `/` 는 영어 원문 | Vitest `archive-error` (`it.fails archive-16`, 6건)                                                                                                                                                | `src/lib/error.ts:96-118` 패턴 부재, ELOOP(40/62) 표 없음                                                                                                                                                | 패턴·문구 추가(S), 장기적으로 BE 구조화 오류(M)                                                                                      | 확인됨 / lead 동의                                                             |

### P3

| ID         | 종류        | 제목                                                                                                                                          | 근거                                                                                              | 수정안                                                                                    | 상태                          |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------- |
| archive-17 | bug         | 대소문자만 다른 이름이 조용히 덮임 (zip·tar·7z). 7z 는 이름은 앞 항목, 내용은 뒤 항목으로 섞임. Windows 이름 치환 후 충돌(`a:b`·`a_b`)도 동일 | `sol_zip/tar_case_collision_not_silent`, `opus2_sevenz_case_collision_not_silent`                 | 실제 충돌 감지 → KeepBoth 또는 알림 (M)                                                   | 확인됨 / opus 조정(범위 확장) |
| archive-18 | bug         | 암호 zip(AES·ZipCrypto) 해제는 링크를 일반 파일로, 실행 비트 버림 — 항목 하나만 암호여도 전체가 이 경로                                       | `sol_zip_encrypted_preserves_*`, `opus2_zipcrypto_preserves_link_and_exec`                        | 암호/비암호 공통 항목 단위 해제 (M, archive-07 과 묶음)                                   | 확인됨 / opus 동의            |
| archive-19 | bug         | rar 폴더 항목 skip → 빈 폴더 누락                                                                                                             | 코드 `archive.rs:489-492`, unrar `open_archive.rs:629`                                            | 폴더도 `extract_with_base` (S)                                                            | 검증 필요 (rar 픽스처 없음)   |
| archive-20 | ux          | ZipCrypto 틀린 암호가 1/256 확률로 헤더 검사 통과 → "손상" 안내, 재입력 기회 없음                                                             | `opus_zipcrypto_wrong_password_passing_header_check`, `sol2_zipcrypto_wrong_password_error_class` | 암호 경로의 deflate/CRC 오류를 NeedPassword 로 (S)                                        | 확인됨 / sol 동의             |
| archive-21 | ux          | 같은 이름이 있으면 묻지 않고 `.bak` 으로 옮김 (`plan.conflict` FE 미사용)                                                                     | `fileActions.ts:633-660`, `App.tsx:1235-1256`                                                     | 바꾸기/새 이름 확인 창 (S~M)                                                              | 확인됨                        |
| archive-22 | bug         | 선택 항목에 결과와 같은 이름 아카이브가 있으면 쓰는 중인 자기 자신이 들어감 (zip·tar.gz)                                                      | `opus_compress_selection_includes_dest_name`, `sol2_self_selection_zip_and_targz`                 | plan 에서 거부 (S)                                                                        | 확인됨 / sol 동의             |
| archive-23 | improvement | 로컬 browse 임시 폴더가 실행 중 누적(앱 시작 때만 정리). browse 에서 고친 뒤 업데이트 없이 나가도 경고 없음                                   | 코드 `lib.rs:388`, `archive.rs:771-776`                                                           | 문맥 이탈 시 정리 + 변경 감지 시 "업데이트할까요?" (M)                                    | 확인됨                        |
| archive-24 | improvement | 압축 이름: `x.tgz` → `x.tgz.tar.gz`, `photo.jpg` → `photo.jpg.zip`, `..`, Windows `con`                                                       | `opus_observe_compress_plan_names`                                                                | 다듬기 (S)                                                                                | 확인됨                        |
| archive-25 | bug         | 원격 browse 실패(틀린 암호·손상) 시 호스트 `~/.duet-tmp/browse-*` 잔존                                                                        | 코드 `archive.rs:808-821`, `fs_ops.rs:1521-1528`                                                  | 실패 시 정리 또는 reap 등록 (S)                                                           | 검증 필요 (remote 팀)         |
| archive-26 | improvement | 해제 알림: 바뀐 이름의 새 이름 미표시. zip·7z·rar 는 알림 자체 없음                                                                           | Vitest `archive-notice` (`it.fails archive-26`)                                                   | `renamed` 를 (from,to) 로 (S)                                                             | 확인됨                        |
| archive-27 | bug         | 원격 이름의 `\` 가 호스트 명령에서 `/` 로 바뀜                                                                                                | `lead_remote_command_keeps_backslash_in_names`, `sol2_remote_backslash_multiple_arguments`        | 원격 경로는 posix_join 으로 만들고 치환 제거 — copy_strategy 공통이라 fileops 와 조율 (M) | 확인됨 / sol 동의             |
| archive-28 | bug         | 끝에 0 패딩이 붙은 단일 .gz 해제 실패 (tar.gz 는 OK)                                                                                          | `lead_gz_trailing_zeros_still_decodes`, `sol2_gz_padding_single_vs_tar`                           | 남은 바이트가 모두 0 이면 EOF (S)                                                         | 확인됨 / sol 동의             |
| archive-29 | bug         | zstd 건너뛰기 프레임(pzstd·seekable)이 있으면 .zst/.tar.zst 실패                                                                              | `lead_zst_skippable_frame_is_ignored`, `sol2_zstd_skippable_middle_single_and_tar`                | SkipFrame 은 길이만큼 건너뛰기 (S)                                                        | 확인됨 / sol 동의             |
| archive-30 | improvement | 분할 압축(`.7z.001`, `.z01`) 미인식·안내 없음                                                                                                 | `lead_split_volume_names`                                                                         | 첫 조각 인식 또는 안내 (M)                                                                | 확인됨                        |
| archive-31 | rule        | 원격 zip 암호가 `unzip -P` 명령행 → 같은 서버 다른 사용자 `ps` 노출                                                                           | 코드 `archive.rs:561-562`                                                                         | 지원 범위 안내 또는 stdin 전달 경로 (M~L)                                                 | 확인됨                        |
| archive-32 | ux          | 원격 unzip exit 1/50·tar 코덱 프로그램 없음 → 원문 오류                                                                                       | 코드 `archive.rs:654-662`                                                                         | 매핑 추가 (S)                                                                             | 검증 필요 (remote 팀)         |
| archive-33 | bug/Windows | tar 폴더 링크를 Windows 에서 파일 링크로 만듦(개발자 모드)                                                                                    | 코드 `platform/links.rs:10-12`                                                                    | 대상이 폴더면 `symlink_dir` (S~M)                                                         | 기기 확인 필요                |
| archive-34 | rule        | §5: Rust 쪽 암호 String zeroize 안 함                                                                                                         | 코드 `fs_ops.rs:1565`                                                                             | `zeroize`/`secrecy` (S, §6)                                                               | 확인됨                        |

## 개선 제안

- **repack 보존 표** (opus, macOS 실행):

  | 항목                                      | zip → repack                       | tar.gz → repack          |
  | ----------------------------------------- | ---------------------------------- | ------------------------ |
  | 숨김 파일·빈 폴더                         | 보존                               | 보존                     |
  | 실행 비트                                 | 잃음                               | 보존 (Windows 에선 잃음) |
  | 수정 시각                                 | 1980                               | 파일 보존                |
  | 심볼릭 링크                               | 복사본                             | 복사본                   |
  | 주석·방식                                 | 잃음                               | —                        |
  | 암호                                      | **잃음**                           | —                        |
  | Windows 에서 `_` 로 바뀐 이름·건너뛴 링크 | 바뀐 이름으로 저장되고 링크는 빠짐 | 같음                     |

  repack 확인 창에서 "보존되지 않는 것" 을 알리는 편이 좋다.

- 여러 아카이브 한 번에 풀기(현재 단일 선택만).
- 원격 7z/rar 더블클릭은 크기 확인 없이 PC 로 통째 다운로드 후 OS 앱으로 연다 — 큰 파일이면 확인.
- 압축·repack·browse-password 실패 토스트에 `detail` 을 넘겨 알림 "자세히" 에 원문을 남긴다(`App.tsx:1243-1255, 1272-1275, 1300-1303, 2320-2325`).

## 기기 확인 필요

| 항목                      | 확인 방법                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| archive-04 실제 흔함      | 한국어 Windows 10/11 탐색기 "보내기 → 압축(zip) 폴더" 로 한글 파일 압축 → `unzip -Z -v` 로 플래그 11·이름 바이트 확인. 반디집·알집 기본 설정도 같은 확인                                          |
| archive-07 zip·7z Windows | 비관리자 Windows 에서 `zip -y` 로 만든 링크 포함 zip 해제(1314 전체 실패 여부). `CON`·`a:b.txt`·`x.`·`q?.txt` 네 항목 zip/7z 해제 결과(생성·스트림·실패). RAM 디스크·네트워크 드라이브로 zip 해제 |
| archive-05                | Windows PC + SSH 서버에서 `x.tar.gz`/`x.zip` browse → 파일 하나 삭제 → Update → 서버에 `.bak` 생겼는지, zip 에 지운 항목 남는지, Ctrl+Z                                                           |
| archive-01 Windows        | 개발자 모드 Windows 에서 소스 링크 + 대상 선점 tar 해제 시 바깥 내용 복사 여부 (Linux 성공 경로도 1회)                                                                                            |
| archive-33                | 개발자 모드 Windows 에서 폴더 링크 든 tar 해제 → 탐색기로 진입 가능한지                                                                                                                           |
| archive-19                | RAR4/RAR5 빈 폴더·폴더 링크·`.part2.rar` 직접 열기·헤더 암호(`-hp`) 픽스처를 WinRAR 로 만들어 해제                                                                                                |
| archive-24 `con.zip`      | Windows 10 이하에서 이름 `con` 으로 압축                                                                                                                                                          |

## 다른 영역으로 넘긴 것

- **fileops**:
  - F-opus-16 UndoCopy(해제·압축·복사 undo 공통)가 그 사이 사용자가 넣은 파일까지 영구 삭제한다(`core/undo.rs:192-199` → `fs.remove`). §3 과 긴장 관계.
  - `shell_escape_path` 의 `\`→`/` 치환(archive-27)은 copy_strategy 공통이다.
- **remote**:
  - 원격 해제 전 검증(`validate_remote_archive`)은 이름의 `..`/절대경로만 본다. 링크 항목 + 그 링크를 거친 쓰기는 호스트 tar/unzip 의 자체 보호에 맡겨진다 — GNU tar·bsdtar·Info-ZIP 버전별 Docker 확인 필요.
  - archive-25(원격 browse 잔존), archive-32(원격 오류 매핑) 실서버 확인.
- **shell-settings / 작업 큐**: archive-14 — 취소가 안 먹는 큰 해제·압축이 로컬 단일 FIFO 큐 전체를 막는다. 큐가 Cancelled 뒤 Completed 를 emit 한다.

## 라운드 기록

- **PLANNING**: lead 가 coverage C-01~C-17 작성.
  - sol 담당: 해제 엔진(zip 방식·인코딩·Windows·7z·rar·tar_unpack).
  - opus 담당: 사용자 흐름(암호·해제 흐름·browse·압축·repack·알림·FE).
  - lead 담당: 포맷 판정·단일 코덱·원격 명령·Windows 크로스.
  - 테스트 파일은 사람별(`archive_review_{lead,opus,sol}.rs`)로 나눠 충돌을 피했다.
- **R1**: sol 24 테스트(13 재현), opus 24 Rust + 23 Vitest(17 재현), lead 7(4 재현) + Windows clippy OK.
  - lead 가 sol 테스트를 재실행해 일치를 확인했다. FE 테스트도 재실행해 일치.
  - sol(Codex)은 보고서를 쓴 뒤 OpenAI 사이버보안 필터로 멈췄다 → 메인이 `.done` 대행.
- **R2 교차 검토**:
  - opus 는 sol 발견 8건을 검토했다: 동의 7, 범위 조정 1(archive-17 에 7z 포함), 반박 0. archive-01 을 앱 경로·browse·새 생성 변형으로 확장했다.
  - sol 은 opus·lead 발견 13건을 검토했다: 동의 13, 반박 0. archive-14 를 결정적으로 재현했고, archive-03 에 취소 계기를 추가했다.
  - lead 는 archive-15·16 을 재확인했다.
  - sol 세션은 이전 대화 맥락 때문에 필터에 계속 걸려 `/new` 로 새 대화를 열었다. 보안 공격 형태 재현은 opus·lead 에게만 배정했다(메인 지시).
- **R3**: 불필요 — 의견이 갈린 것 없음. 남은 `검증 필요` 는 픽스처 생성 불가(rar)이거나 remote 팀 실서버 몫.
- 합계: 교차 검토 21건 중 동의 20, 범위 조정 1, 반박 0.

## 재현 테스트

- 커밋: `5845557` (`review/archive`, 테스트·픽스처만. `core/archive.rs` 는 `#[cfg(test)] #[path]` 모듈 선언 11줄만 추가)
- 파일:
  - `src-tauri/src/core/archive_review_lead.rs`, `archive_review_opus.rs`, `archive_review_sol.rs`
  - `src-tauri/tests/fixtures/archive/review/`: zip 픽스처 13개 + `generate_sol.py` + README 2개
  - `src/lib/__review__/archive-error.test.ts`, `src/hooks/__review__/archive-notice.test.ts`, `src/stores/__review__/archive-context.test.ts`
- 표시 규칙:
  - 올바른 동작을 assert 하는 재현은 `#[ignore = "archive-NN repro"]` / `it.fails("archive-NN: …")`. 수정 후 표시를 떼면 회귀 테스트가 된다.
  - `sol2_*` 는 현재 결함을 관찰하는 테스트(통과 = 결함 있음)라 `#[ignore = "archive-NN 현재 결함을 관찰 … 수정 시 기대값 반전"]` 으로 표시했다.
  - `opus_compress_zip_over_4gib_file`·순환 링크 테스트는 단독 실행용이다.
- 실행:
  ```bash
  H=/Users/ctmctm/Desktop/01_PROJECT/duet-ux/_review/bin/heavy.sh
  bash $H cargo test --manifest-path src-tauri/Cargo.toml --lib review_archive                     # 27 passed, 53 ignored (green)
  bash $H cargo test --manifest-path src-tauri/Cargo.toml --lib review_archive -- --ignored --skip over_4gib --skip symlink_loop   # 34 failed(=재현), 15 passed(=sol2 관찰·temp 공유)
  bash $H cargo test --manifest-path src-tauri/Cargo.toml --lib review_archive_lead::lead_repack_plan_uses_fs_join -- --ignored --exact   # 개별 재현 예
  bash $H pnpm exec vitest run --minWorkers=1 --maxWorkers=2 src/lib/__review__/ src/hooks/__review__/ src/stores/__review__/   # 23 passed (9 it.fails)
  ```
- 검증:
  - `cargo clippy --lib --tests` exit 0 (경고는 기존 `fs/local.rs:637` 1건).
  - Windows 크로스 clippy exit 0.
  - `pnpm exec tsc --noEmit`·eslint 통과.
  - 리뷰 파일 rustfmt 통과.
