# archive 수정 최종 보고

## 요약

- **P1 3건 고침**: U-01/archive-01(tar 해제·browse 가 폴더 밖을 쓰고 읽던 보안 구멍), U-05/archive-04(한국어 Windows zip 이름 깨짐), U-09/archive-02(하위 폴더 Update archive 가 나머지를 날림). 승인된 의존성(zip 9 + encoding_rs)은 별도 커밋 `2785d9d`.
- **P2 6건 고침**: archive-06(7-Zip·반디집 방식 zip), archive-07(zip·7z Windows 이름·링크), archive-08(읽기 전용 폴더 tar), archive-10(압축이 링크를 따라감), browse-06+SC-21(CP949·UTF-16 미리보기). **P3 4건**: archive-17·18·SC-28 고침, archive-33 부분 수정.
- 못 고친 것: Shift-JIS zip 이름(CP949 와 구분 불가, 범위 밖), archive-33 의 "대상 폴더가 링크보다 뒤" 경우, 7z 안 심볼릭 링크(예전처럼 일반 파일).
- 위험: tar·zip·7z 해제 엔진을 항목 단위 구현으로 바꿨다(zip crate `extract`·sevenz `decompress_file` 미사용). macOS 테스트·Windows 교차 컴파일은 통과했지만 Windows 실기 확인이 남는다(아래).
- 게이트: 새 실패 없음. 남은 실패는 모두 fix/base 기준선(메인 공지 제외 목록 + `mvp2_smoke` 1건 + prettier 기존 파일).

## 고친 것

| ID                          | 사용자에게 달라지는 점                                                                                                                                                                                                                                         | 커밋                                                                                                                                   | 테스트                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| U-01 / archive-01 (P1 보안) | 악성 tar 를 풀거나 더블클릭으로 보기만 해도 해제 폴더 밖 파일이 생기거나 덮이거나 바깥 내용이 복사되던 것이 막힘. 하드링크 복사 폴백은 "하드링크 미지원" 오류에서만, 링크는 따라가지 않음(lstat, `create_new`, 임시 이름 + rename 으로 교체 — `remove_*` 없음) | `702a108`, `63df37c`(교체 전 권한 적용, R2)                                                                                            | repro 6개 해제(`opus2_hardlink_*`, `opus2_browse_hardlink_attack_writes_outside`, `sol_tar_hardlink_*`) + `tar_unpack::tests` 회귀 다수, `write_new_file_keeps_destination_when_finish_fails` |
| archive-08 (P2)             | 읽기 전용 폴더(0555/0500)가 든 tar(Go 모듈 등)가 풀림. 폴더 권한은 모든 항목을 쓴 뒤 깊은 것부터                                                                                                                                                               | `ec08a00`                                                                                                                              | `opus2_tar_readonly_dirs_0500_and_nested_0555`, `sol_tar_readonly_directory_children` + 새 3개                                                                                                |
| 의존성(D-1·D-2·D-4)         | zip 2.4.2 → 9.5.0 (bzip2·lzma·xz·ppmd·zstd), encoding_rs 0.8.44. zstd-sys 는 Windows 교차 빌드 통과                                                                                                                                                            | `2785d9d`                                                                                                                              | 기존 테스트 전부                                                                                                                                                                              |
| archive-06 (P2)             | BZip2·LZMA·Zstd·XZ·PPMd 방식 zip 해제·내부 보기                                                                                                                                                                                                                | `6e484e9`                                                                                                                              | `sol_zip_bzip2/lzma/zstd`(Python 픽스처), `zip_xz_and_ppmd_methods_extract_and_browse`(zip crate 생성)                                                                                        |
| U-05 / archive-04 (P1)      | UTF-8 표시 없는 CP949 zip 이름이 한글로 보임(해제·browse). 규칙: 원시 이름이 UTF-8 로 유효하면 그대로, 아니고 CP949 로 유효하면 CP949, 아니면 CP437                                                                                                            | `251024b`, `2b558ea`, `e847da0`                                                                                                        | `zip_names::tests`, `sol_zip_cp949_names`, `opus2_zip_cp949_names_extract_and_browse`(browse 단언 포함), `sol_zip_unicode_extra` 유지                                                         |
| U-09 / archive-02 (P1)      | 압축 내부 하위 폴더에서 Update archive 를 눌러도 아카이브 전체가 다시 묶임. BE 도 browse 하위 폴더 repack 을 거부                                                                                                                                              | `42f7880`, `9f1f118`                                                                                                                   | `opus_repack_from_subfolder_keeps_other_entries`·`sol2_subfolder_repack_zip_and_targz`(실제 browse 경로로 재작성), `archive.rs` 단위 3개, Vitest `repackBrowseRoot` 4개                       |
| archive-07 (P2)             | zip·7z 도 tar 처럼 항목 단위: Windows 금지 이름(`?\*<>                                                                                                                                                                                                         | ":`, CON, 끝의 점)은 `\_` 로 바꿔 풀고 알림, 링크를 못 만들면 그 링크만 건너뛰고 알림, 링크 경유 쓰기 거부. zip·7z 도 해제 알림이 나감 | `2b558ea`, `3cbd907`(링크 먼저, R2), `32dfcc4`(드라이브·UNC 접두사 zip crate 호환, R2)                                                                                                        | `zip_unpack::tests` (Windows 규칙 주입 테스트 포함) |
| archive-18 (P3)             | 암호 zip 도 링크·실행 비트 보존                                                                                                                                                                                                                                | `2b558ea`                                                                                                                              | `sol_zip_encrypted_preserves_*`, `opus2_zipcrypto_preserves_link_and_exec`                                                                                                                    |
| archive-17 (P3)             | 대소문자만 다른 이름(그리고 Windows 치환 뒤 같아진 이름)이 조용히 덮이지 않고 `이름 (2).ext` 로 둘 다 남음 + 알림. tar·zip·7z 공통                                                                                                                             | `92c146d`, `9d4b871`(중첩 폴더 이동 합성, R2)                                                                                          | `sol_zip/tar_case_collision_not_silent`, `opus2_sevenz_case_collision_not_silent`, NameGuard 단위·실제 tar/zip 테스트                                                                         |
| archive-10 (P2)             | 압축·repack 이 링크를 링크로 저장. 대상 없는 링크·순환 링크로 전체 실패하지 않고, 바깥 내용이 아카이브에 들어가지 않음                                                                                                                                         | `02460e4`                                                                                                                              | `opus_compress_zip/targz_symlink_loop`, `opus_compress_zip_two_symlink_loops_hang`, `sol2_file_symlink_and_dangling_both_formats`(반전) + 외부 대상 테스트                                    |
| browse-06 + SC-21 (P2)      | 미리보기: UTF-8/UTF-16 BOM, CP949 텍스트가 보임. 비UTF-8 뒷부분을 조용히 자르지 않음. BOM 으로 시작하는 바이너리는 여전히 바이너리                                                                                                                             | `663ac44`, `f3eaff5`(R2), `f1cc143`                                                                                                    | `fs_ops.rs` `mod review_browse`·`review_sync_compare_opus_preview` repro 해제·기대값 반전, 경계 테스트 다수, `tests/review_browse_sol2_preview.rs` 소스 문자열 단언 갱신                      |
| SC-28 (P3)                  | 비교 CSV 내보내기가 UTF-8 BOM 으로 시작(Excel 한글), `= + - @ TAB CR` 로 시작하는 이름은 `'` 로 중화                                                                                                                                                           | `219fcf4`                                                                                                                              | `compare.rs` 단위, `tests/review_sync_compare_sol.rs` 2개(메인 지시)                                                                                                                          |
| archive-33 (P3, 부분)       | Windows 에서 해제 폴더 안의 **이미 풀린** 폴더를 가리키는 링크는 폴더 링크(`symlink_dir`)                                                                                                                                                                      | `b98b66f`                                                                                                                              | `link_target_is_dir_*` 2개 (Windows 동작은 교차 컴파일만)                                                                                                                                     |

## 못 고친 것·부분 수정

- **archive-33 부분**: 대상 폴더가 아카이브에서 링크보다 **뒤**에 나오면 여전히 파일 링크. 고치려면 링크 생성을 끝으로 미뤄야 하는데, 그러면 "앞 링크를 거쳐 쓰기" 판정 의미가 바뀌어 보안 재검토가 필요하다 — 이번 라운드 제외(lead 결정).
- **Shift-JIS zip 이름**: CP949 로도 "유효하게" 풀리는 경우가 많아 구분 불가. `sol_zip_sjis_names` 는 ignore 유지(사유 갱신).
- **7z 안의 심볼릭 링크**: 예전처럼 일반 파일로 풀림.
- **암묵 부모 충돌**: 파일 `a` 뒤에 폴더 항목 없이 `A/child` 가 오면(대소문자 무시 FS) 예전처럼 오류로 끝남(조용히 덮지는 않음). NameGuard doc 에 한계로 기록.
- 파일 길이: `tar_unpack.rs`(제품 ~600줄)·`zip_unpack.rs`(제품 ~400줄, 테스트 포함 800줄)가 CLAUDE.md 500줄 검토 기준을 넘는다. NameGuard·테스트 분리는 후속 리팩터링 후보.

## 동작 변화로 알아둘 것

- zip 의 `..` 가 든 항목: 예전 비암호 zip 은 해제 **전체 실패**, 이제 그 항목만 건너뜀(tar·예전 암호 zip 과 같음). `a/../b` 도 건너뜀(zip crate 는 `b` 로 풀었음 — 더 보수적).
- zip 이름의 드라이브 접두사는 zip crate 와 같이 뗀다. 그 결과 `a:b.txt` 처럼 "영문 한 글자 + `:`" 로 시작하는 조각은 `b.txt` 로 풀린다(예전 zip crate 와 같음). `log 10:00.txt` 같은 일반 `:` 는 Windows 에서 `_` 치환.
- 해제 알림 문구(ko/en `toast.archiveRenamed_*`)를 "그대로 쓸 수 없어(: ? 같은 글자, 대소문자만 다른 같은 이름 등) 바꾼 이름으로" 로 넓혔다(키 순서 유지).
- 미리보기 바이너리 판정의 30% 경계가 정수 나눗셈 대신 정확한 비교가 됐다(경계 근처 파일만 영향).

## 다른 팀 파일과 겹칠 수 있는 곳

- `src-tauri/Cargo.toml`·`Cargo.lock` — 이 팀 전담(메인 확인: archive 를 먼저 통합).
- `src-tauri/src/core/archive.rs` — `extract_local_blocking`·`extract_sevenz`(경로 기반 위임), `extract_zip_with_password` 삭제, `repack_plan`(가드 추가), `compress_local_blocking`·`add_to_zip`. **paths 팀**이 같은 파일의 `repack_plan` dest 경로 줄(`PathBuf::join` → `fs.join`, archive-05)과 원격 경로 조립(~769)을 고친다 — 그 줄은 건드리지 않았지만 같은 함수라 인접 hunk 충돌 가능.
- `src-tauri/src/commands/fs_ops.rs` — `decode_text`·`looks_binary`(~1870-1960)와 그 테스트 모듈. browse 팀이 같은 파일의 다른 command 를 고칠 수 있음.
- `src-tauri/tests/review_browse_sol2_preview.rs` — browse-06 테스트 1개의 두 줄만(browse 팀이 같은 파일의 browse-01·33 테스트를 손댈 수 있음).
- `src-tauri/src/core/compare.rs` — CSV 내보내기·`csv_field`. `src-tauri/tests/review_sync_compare_sol.rs` — CSV 테스트 2개.
- `src/App.tsx` — `onUpdateArchive` 와 import 한 줄. browse·errors 팀도 App.tsx 를 고침.
- `src/i18n/ko.json`·`en.json` — `toast.archiveRenamed_*` 문구 값만(키 추가 없음).
- `src/hooks/__review__/archive-notice.test.ts` — 영어 문구 기대값 1줄.
- `platform/links.rs` — `create_symlink(target, link, target_is_dir)` 로 시그니처 변경(호출처는 core 의 tar/zip 해제기뿐).

## IPC·설정·저장 형식 변경

- IPC command·타입 변경 없음(`gen:bindings` 후 `tsc` 통과). `ArchiveNoticeEvent` 필드 무변경(필드 doc 만).
- `PreviewData` 무변경. CSV 내보내기 내용이 BOM 으로 시작(소비자는 BE 파일 쓰기뿐, FE 파싱 없음 — opus 리뷰 확인).
- 설정·저장 형식 변경 없음.

## 기기 확인 필요

- **Windows 실기**
  - zip·7z: `?*<>|":`·CON·끝의 점 이름 → `_` 치환 + 알림. 비관리자에서 링크 든 zip(`zip -y`) → 링크만 건너뛰고 알림. RAM 디스크·네트워크 드라이브 해제.
  - 개발자 모드: 폴더 링크 든 tar/zip 해제 후 탐색기 진입(archive-33), 대상이 링크 앞/뒤 두 경우.
  - FAT/exFAT USB: 하드링크 든 tar → 복사 폴백(오류 1/50 판정 추정 — 문서 근거만), 같은 이름 재등장 시 rename 교체.
  - 대소문자만 다른 이름 → `이름 (2)` + 알림.
  - 압축: junction·절대 대상 링크를 zip 으로 압축 → 다른 PC 에서 해제(대상 문자열 `C:/…`·`//?/…`).
- **실제 산출물**: 한국어 Windows 탐색기 "압축(zip) 폴더"·반디집·알집이 만든 CP949 zip 해제·browse. 7-Zip 이 만든 XZ·PPMd·Zstd zip(테스트는 zip crate·Python 생성물).
- 원격(서버 unzip) 은 이번 범위 밖: 서버 unzip 은 Zstd·XZ·PPMd zip·CP949 이름을 서버 설정에 따라 다르게 처리한다.

## 게이트 결과 (lead worktree, `fix/archive` 마지막 커밋 기준)

| 명령                                                                    | 결과                                                                                                                                                                                            | fix/base 대비                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --check`                                                     | 통과                                                                                                                                                                                            | 같음                                                                                                                                                                              |
| `cargo clippy --all-targets -D warnings`                                | 실패 — `tests/review_remote_opus_chaos.rs:54,518,532`, `core/ops.rs:5656`, `fs/local.rs:637` 만                                                                                                 | **기준선 실패, 변화 없음**(메인 공지 제외 목록)                                                                                                                                   |
| `cargo clippy --target x86_64-pc-windows-gnu --all-targets -D warnings` | 실패 — 위와 같은 파일만. archive 팀 파일의 Windows dead*code(`opus2*\*`)는 `5713b84` 로 해소                                                                                                    | 기준선 실패, archive 파일 몫은 줄어듦                                                                                                                                             |
| `cargo clippy --target x86_64-pc-windows-gnu --lib -D warnings`         | 통과                                                                                                                                                                                            | 같음                                                                                                                                                                              |
| `cargo test --lib`                                                      | 통과 (514 passed / 80 ignored)                                                                                                                                                                  | 새 실패 없음                                                                                                                                                                      |
| `cargo test --tests --no-fail-fast`                                     | `mvp2_smoke::smoke_copy_with_conflict_creates_backup_and_undo_restores` 1건 실패, 나머지 통과(`review_browse_sol2_preview` 는 수정 커밋 후 3 passed)                                            | **기준선 실패**: 테스트·copy/undo 코드(`ops.rs`·`undo.rs`·`fs/`) 모두 이 브랜치에서 무변경. `.bak` 1개를 기대하는데 2026-06 Replace 예외(백업 없이 덮어쓰기)와 어긋난 기존 테스트 |
| `pnpm gen:bindings` + `tsc --noEmit`                                    | 통과                                                                                                                                                                                            | 같음                                                                                                                                                                              |
| `pnpm lint`                                                             | 통과                                                                                                                                                                                            | 같음                                                                                                                                                                              |
| `prettier --check .`                                                    | 실패 — 61 파일, 모두 이 브랜치에서 무변경인 기존 파일. 예외 1개 `src/hooks/__review__/archive-notice.test.ts`(기대 문구 1줄 수정)는 **fix/base 원본도 prettier 불일치**(stdin 포맷 비교로 확인) | 기준선 실패, 변화 없음                                                                                                                                                            |
| `vitest run`                                                            | 통과 (141 files / 924 tests)                                                                                                                                                                    | 같음                                                                                                                                                                              |

로그: `/tmp/fx-archive-final-{fmt,clippy,clippy-win,lib,tests,bind,tsc,lint,prettier,vitest}.log`, `review_browse_sol2_preview` 재실행 `/tmp/fx-archive-bsp.log`.

## 라운드 기록

- **PLANNING**: brief + 추가 배정(의존성·U-05·archive-06·browse-06/SC-21) 반영. 파일 소유를 나눔(opus: tar_unpack·zip_unpack, sol: repack_plan·compress·decode_text·compare CSV·FE, lead: Cargo·zip_names·테스트). 보안 재현(U-01) 은 sol 에 배정하지 않음.
- **R1**: lead — 의존성 커밋, archive-06 테스트, CP949 판정 헬퍼. opus-1 — archive-01·08·공유 헬퍼·33. sol-1 — archive-02. sol-2 — browse-06·SC-21·SC-28·archive-10 (메인 지시로 `review_sync_compare_sol.rs` 2개 추가). opus-2 — archive-07·18·U-05 적용·17. lead 가 모든 커밋을 읽고 판정 후 cherry-pick.
- **R2 교차 리뷰** (지적 6건, 모두 처리):
  - lead → archive-01 승인.
  - sol-3 → opus-1: 08 승인, 헬퍼 리팩터링 수정 요청 2(P2 복사 폴백이 권한 적용 전에 교체 / P3 doc 누락) → opus-3 고침. 33 질문 → lead: 부분 수정으로 기록.
  - opus-4 → sol 5커밋 모두 승인 + P3 제안 1(BOM 바이너리) → sol-5 고침.
  - sol-4 → opus-2: 헬퍼 승인, 수정 요청 3(P2 링크/폴더 판정 순서, P2 중첩 폴더 이동 합성, P3 드라이브·UNC 접두사) → opus-5 고침(lead 결정: zip crate 호환). 비차단 1(CP949 browse 단언) → opus-5 반영.
- **R3**: opus-5·sol-5 로 R2 지적 마무리. lead — Windows dead_code(`5713b84`), FINALIZING 중 발견한 `review_browse_sol2_preview` 소스 문자열 단언 갱신.
- 다른 팀으로 넘긴 것(`to-main.md`): 원격 zip 압축 `-y`(링크 보존), Windows 비관리자 browse→repack 시 건너뛴 링크 소실 경고(새 이슈 후보).

## 커밋 목록 (`git log --oneline fix/base..fix/archive`)

```
f1cc143 test: drop old decode_text source checks from browse-06 evidence test
f3eaff5 be/cmd: treat BOM-prefixed binary data as binary in previews
e847da0 test: assert CP949 names in the archive browse view too
32dfcc4 be/core: parse zip drive and UNC prefixes like the zip crate
9d4b871 be/core: compose nested folder moves in NameGuard
3cbd907 be/core: check zip link entries before folder entries
5713b84 test: compile opus2 tar helpers only on unix
2e6c052 be/core: document tar_unpack write_error
63df37c be/core: finish replacement files before swapping them in
92c146d be/core: keep both entries on case-only name collisions
2b558ea be/core: extract zip and 7z entry by entry like tar
e7ffdba be/core: share tar_unpack path and mode helpers
02460e4 be/core: store symlinks as links when compressing
219fcf4 be/core: add BOM and formula guard to compare CSV export
663ac44 be/cmd: decode BOM, UTF-16 and CP949 text in previews
b98b66f be/platform: make folder symlinks as directory links on Windows
d94a0ae be/core: expose tar_unpack safety helpers for other unpackers
ec08a00 be/core: apply tar folder permissions after all entries
c9de478 be/core: rustfmt tar_unpack
9f1f118 fe/ui: repack from the archive browse root
42f7880 be/core: reject repack from a browse subfolder
702a108 be/core: stop tar hard-link fallback from following symlinks
251024b be/core: add CP949 fallback for zip entry names
6e484e9 test: cover BZip2, LZMA, Zstd, XZ and PPMd zip extraction
2785d9d build: upgrade zip to 9 with more methods, add encoding_rs
```
