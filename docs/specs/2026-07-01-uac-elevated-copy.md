# UAC 승격 복사 (Windows 보호 폴더 쓰기) — 설계

> 2026-07-01. `C:\Program Files (x86)` 같은 **관리자 권한 필요 폴더**로 복사가
> `os error 5 (Access denied)` 로 실패하는 문제. 탐색기처럼 **진짜 UAC 승격 창**을
> 띄우고, 승격된 프로세스가 복사를 수행한다.

**상태**: 설계 검토중 (미승인 · 미구현). 보안 민감 → 승인 후 구현.
**범위(제안)**: v1 = **복사(copy) 전용, 로컬→로컬, Windows 전용**. 이동/삭제/원격 제외.
**의존성**: 신규 0 (`windows` crate 에 `ShellExecuteExW` + COM 이미 있음).
**리모트 영향**: 없음 (로컬·Windows 한정, SSH 경로는 `PermissionDenied` 트리거에서 제외).

---

## 1. 문제

- duet 은 일반(비승격) 권한으로 실행된다. `C:\Program Files (x86)`, `C:\Windows`
  등 보호 폴더는 쓰기에 관리자 토큰이 필요 → `tokio::fs::write` 가 `os error 5`.
- 탐색기가 되는 건 특별해서가 아니라, 복사 시 **UAC 승격 동의 창**("계속하려면
  관리자 권한을 제공해야 합니다")을 띄우고, 동의하면 승격된 컨텍스트로 복사하기 때문.
- 특수문자(공백·`(x86)`)는 무관 — 로컬 복사는 셸을 안 거치고 경로를 `&Path` 로
  OS 에 직접 넘긴다(`fs/local.rs::write_full`). 순수 권한 문제.

## 2. 보안 원칙 (가장 중요)

### 2.1 안 하는 것 — `IFileOperation` 조용한 자동 승격 ❌

`IFileOperation` COM 을 비승격 프로세스에서 호출해 **UAC 창 없이** 보호 폴더에
쓰는 방식이 있으나, 이는 **explorer.exe 를 사칭(PEB 스푸핑)하는 알려진 UAC 우회
공격 기법**이다. 특정 UAC 레벨에서만 동작하고, 멀웨어가 쓰는 방법이라:

- 정식 파일매니저에 넣으면 **안티바이러스가 duet 을 멀웨어로 탐지**할 수 있음.
- 사용자 동의 없는 권한 상승 = 신뢰 위반.

→ **채택하지 않는다.** 어떤 형태로도 UAC 우회는 구현 금지.

### 2.2 하는 것 — `runas` 로 진짜 UAC 창 ✅

`ShellExecuteExW(lpVerb = "runas")` 로 duet.exe 를 재실행 → **OS 표준 UAC 동의
창**. 사용자가 명시적으로 동의해야만 승격. 탐색기의 "계속" 버튼과 동일한 정식 경로.

### 2.3 Confused-deputy 방어 (승격 헬퍼 오남용 차단)

승격된 프로세스가 "파일을 읽어서 무엇을 할지 결정"하는 것은 공격면이다. 위협:
같은 사용자 계정의 다른 프로세스가 **duet 의 승격 헬퍼를 속여** 공격자 파일을
시스템 경로(예: `System32`)에 복사하게 만드는 것(권한 상승 발판).

**방어 설계:**

1. **작업 명세는 manifest 파일**로 전달하되, 그 파일의 **SHA-256 해시를
   커맨드라인 인자로 함께 전달**한다. 승격된 자식은 manifest 를 읽어 해시를 재계산,
   **불일치면 즉시 중단**. 커맨드라인은 `ShellExecuteEx` 시점에 고정되어 실행 후
   변경 불가 → **launch 이후 manifest 변조(TOCTOU) 탐지**.
2. manifest 는 **현재 사용자만 쓰기 가능한 디렉토리**(`%LOCALAPPDATA%\duet\elevated\`)
   에 **랜덤 파일명**으로 쓰고, 자식이 읽은 **즉시 삭제**(짧은 수명).
3. 승격 헬퍼는 **오직 manifest 의 copy op 만** 수행. 다른 어떤 동작도 없음.
   경로는 절대경로·정규화 검증. op 종류는 화이트리스트(`copy` 만).
4. UAC 창은 "duet.exe 가 변경하려 합니다"를 표시 → 사용자는 **duet 의 작업**에
   동의하는 것. 헬퍼가 그 범위를 벗어나지 않도록 위 1~3 이 보장.

> 잔여 위험: 공격자가 manifest **와** 커맨드라인 해시를 **둘 다** 바꿔야 하는데,
> 커맨드라인은 launch 후 불변이라 불가능. 소스 파일 자체 스왑은 탐색기와 동일
> 수준의 위험(사용자가 선택한 소스를 복사)으로 수용.

## 3. 아키텍처

### 3.1 헬퍼 = duet.exe 재사용 (단일 바이너리)

별도 헬퍼 exe 를 안 만들고, duet.exe 에 **숨은 서브커맨드**를 둔다:

```
duet.exe --elevated-op <manifest-path> --manifest-sha256 <hex>
```

`main.rs`/`run()` 최상단에서 argv 를 검사 → `--elevated-op` 이면 **GUI 를 띄우지
않고** 승격 op 핸들러 실행 후 종료. (single-instance 플러그인보다도 먼저 분기.)

### 3.2 흐름

```
[비승격 duet]                                   [승격 duet (--elevated-op)]
1. 로컬 copy 실행 → PermissionDenied(os err 5)
2. FE 다이얼로그:
   "관리자 권한 필요 — 관리자로 다시 시도?"
3. 동의 → BE:
   a. manifest(JSON) 을 %LOCALAPPDATA%\duet\elevated\<rand>.json 에 기록
   b. sha256(manifest) 계산
   c. ShellExecuteExW(runas, duet.exe,
      "--elevated-op <path> --manifest-sha256 <hex>")
      → ★ UAC 창 ★
4. (사용자 동의 시)  ───────────────────────►   d. manifest 읽기 + 해시 검증
                                                e. 검증 실패 → 즉시 종료(비0)
                                                f. copy 수행(IFileOperation
                                                   또는 std::fs::copy, 이제 승격됨)
                                                g. result JSON 기록
                                                h. manifest 삭제, 종료(exit code)
5. WaitForSingleObject(프로세스 핸들)
6. result JSON 읽기 → 성공/실패 per item
7. journal 기록(§4) + 패널 새로고침 + 토스트
```

- UAC 거부 시: `ShellExecuteExW` 가 `ERROR_CANCELLED(1223)` → FE "취소됨".

### 3.3 승격 헬퍼의 실제 복사 API

두 선택지:
- **(A) `std::fs::copy`** — 단순. 승격됐으므로 보호 폴더 쓰기 가능. 충돌/진행률은
  헬퍼가 직접 처리. v1 권장(단순·의존성 0·검증 쉬움).
- **(B) `IFileOperation`(COM)** — 탐색기 복사 엔진. 진행률 UI·충돌 처리 기본 제공.
  단 v1 엔 과함. (2.1 의 "우회"와는 무관 — 여기선 이미 정식 승격된 상태에서 호출.)

→ **v1 = (A) std::fs::copy.** 필요 시 후속에서 (B) 로 업그레이드.

## 4. undo / journal (§4 안전성)

- copy 는 원본 비파괴. "작업"은 dst 에 생성된 파일들.
- undo(생성 파일 삭제)도 **보호 폴더라 승격 필요** → undo 시 UAC 창 재등장.
- **v1 정책 (택1, 문서 승인 필요):**
  - **(가)** journal 에 승격 copy 를 기록하되 `undo = 승격 필요`로 표시. Ctrl+Z 시
    "이 작업 취소는 관리자 권한이 필요합니다 — 승격할까요?" → 승격 delete op.
  - **(나)** v1 은 journal 에 audit 성격만 기록(undo 미지원), 승격 undo 는 후속.
  - 제안: **(나)** 로 시작(단순), (가)는 후속. 어차피 보호 폴더 파일을 실수로
    넣는 빈도는 낮고, 되돌리려면 어차피 승격이 필요함을 안내.

## 5. UX

- 트리거 조건: **Windows + 로컬→로컬 + 에러가 `PermissionDenied`** 일 때만.
  (원격·기타 에러는 기존 실패 토스트 그대로.)
- 실패 시 토스트 대신 **다이얼로그**:
  - 제목: "관리자 권한 필요"
  - 본문: "'…\Program Files (x86)' 에 쓰려면 관리자 권한이 필요합니다."
  - 버튼: **[관리자 권한으로 다시 시도]** · [취소]
- 다시 시도 → UAC 창 → 결과 토스트.
- **작업마다 UAC 창** (승격 캐시는 승격 프로세스 상주가 필요 → 보안 위험이라 안 함).
  탐색기도 동일.

## 6. IPC 명세 (Tauri command)

```rust
/// 직전 실패한 로컬 복사를 관리자 권한으로 재시도. Windows 전용.
/// plan 은 이미 충돌 해소가 끝난 CopyPlan(기존 fs_copy_plan 결과) 재사용.
#[tauri::command]
async fn fs_copy_execute_elevated(plan: CopyPlan) -> Result<ElevatedOutcome, DuetError>;

struct ElevatedOutcome {
    ok: u32,           // 성공 항목 수
    failed: Vec<String>, // 실패 dst + 사유
    cancelled: bool,   // 사용자가 UAC 거부
}
```

- 기존 `fs_copy_plan` 으로 충돌까지 해소 → `fs_copy_execute` 실패(PermissionDenied)
  → FE 가 `fs_copy_execute_elevated(plan)` 호출. **plan 재사용**으로 경로/충돌 로직
  중복 없음.
- 대안: `fs_copy_execute(plan, elevated: bool)` 단일 커맨드에 플래그. → 시그니처
  변경 파급 커서 **별도 커맨드**가 안전.

## 7. 레이어 분해

| 레이어 | 파일 | 책임 |
|--------|------|------|
| platform | `platform/elevate.rs` (신규, `#[cfg(windows)]`) | `run_elevated_op(manifest, hash) -> Outcome` (ShellExecuteEx runas + Wait + exit code/result 읽기), `execute_elevated_op(manifest, expected_hash)` (자식측: 검증+copy+result) |
| 진입점 | `main.rs` / `lib.rs::run()` | argv `--elevated-op` 조기 분기 → GUI 미기동 |
| core | `core/ops.rs` | manifest 빌드(CopyPlan→items), result→journal |
| commands | `commands/fs_ops.rs` | `fs_copy_execute_elevated` |
| FE | `dialogs/ElevatePromptDialog.tsx`(신규) + `fileActions.ts` | PermissionDenied 감지 → 다이얼로그 → 커맨드 호출 |
| types | `types/` | manifest/result 구조체 (specta) |

- §7: 경로 결합/분기는 `platform`·`fs` 레이어. manifest 경로는 절대경로 그대로.
- §8: `ShellExecuteExW` 는 `platform/` 의 `unsafe` (안전조건 주석).

## 8. manifest / result 포맷

```jsonc
// manifest (%LOCALAPPDATA%\duet\elevated\<rand>.json)
{
  "version": 1,
  "op": "copy",                       // 화이트리스트 (v1: copy 만)
  "conflict": "overwrite",            // FE 에서 이미 해소된 정책
  "result_path": "…\\<rand>.result.json",
  "items": [
    { "src": "C:\\Users\\x\\a.dll",
      "dst": "C:\\Program Files (x86)\\App\\a.dll" }
  ]
}
```
```jsonc
// result
{ "items": [ { "dst": "…\\a.dll", "ok": true },
             { "dst": "…\\b.dll", "ok": false, "error": "…" } ] }
```

## 9. 엣지·실패 모드

- UAC 거부 → `cancelled: true`, 아무 변화 없음.
- 승격 헬퍼가 해시 불일치 → 비0 종료, `failed` 로 보고("integrity check failed").
- 승격 프로세스 크래시 → Wait 가 프로세스 종료 감지, result 없으면 실패 처리.
- 부분 실패(일부 항목만) → per-item result 로 정확히 보고.
- 소스가 SSH/원격 → 애초에 트리거 안 됨(로컬→로컬 한정). 원격 승격은 범위 밖.
- manifest 디렉토리 생성 실패 → 승격 시도 자체 실패, 기존 에러로 폴백.

## 10. 테스트

- **유닛(크로스플랫폼)**: manifest/result serde 라운드트립, 해시 계산·검증 로직
  (변조 시 reject), CopyPlan→manifest items 변환.
- **Windows 크로스컴파일**: `cargo clippy --target x86_64-pc-windows-gnu`.
- **수동(실기 Windows)**:
  1. `Program Files (x86)` 로 복사 → 다이얼로그 → UAC 동의 → 성공.
  2. UAC 거부 → "취소됨", 원본/대상 무변화.
  3. manifest 변조 시뮬(해시 불일치) → 중단.
  4. 부분 실패(읽기 전용 파일 섞기) → per-item 보고.

## 11. v1 범위 밖 (후속)

- 이동(move)·삭제 승격 (원본 삭제 = undo·journal 승격 경계 처리 필요).
- 승격 undo (§4 (가)).
- 원격 sudo 승격 (별개 주제).
- `IFileOperation` 진행률/충돌 UI (§3.3 B).
- 승격 배치(한 UAC 로 여러 작업) — 이미 배치(items[]) 지원, 단 세션 간 캐시는 안 함.

## 12. 미결 질문 (승인 시 확정)

1. **범위**: 복사만(v1 제안) vs 복사+이동?
2. **undo 정책**: (나) v1 미지원 + 안내(제안) vs (가) 승격 undo?
3. **복사 API**: (A) std::fs::copy(제안) vs (B) IFileOperation?
4. **헬퍼**: duet.exe 재사용(제안) vs 별도 최소 헬퍼 exe(공격면 축소)?
5. **트리거 UX**: 실패 후 다이얼로그(제안) vs 복사 전 목적지가 보호폴더면 사전 경고?

---

## 부록: 왜 "이 폴더에 넣지 마세요"가 아니라 기능을 만드나

Program Files 는 시스템 폴더라 보통 사용자 데이터를 넣지 않지만, 실사용(게임
모드·DLL 교체·설정 파일 배치 등)에서 정당한 필요가 있다. 탐색기가 제공하는 기능을
duet 이 못 하면 "TC 대체" 목표에 구멍. 단 **정식 UAC 경로로만**(§2) 제공한다.
