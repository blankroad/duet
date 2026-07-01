# 원격 sudo 승격 복사 (SSH 서버 보호 경로 쓰기) — 설계

> 2026-07-01. 리눅스 SSH 서버의 root 소유 경로(`/etc`, `/usr/local/bin` 등)로 복사가
> `permission denied` 로 실패하는 문제. 서버에서 **`sudo`** 로 재시도. UAC 승격
> (`docs/specs/2026-07-01-uac-elevated-copy.md`)의 **원격 대응판** — 메커니즘은 완전히 다름.

**상태**: 설계 검토중 (미승인 · 미구현). 보안 민감(§5 자격증명, §9 russh) → 승인 후 구현.
**범위(제안)**: v1 = **복사만**, dest 가 SSH 이고 `PermissionDenied`. Local→Remote +
Remote→Remote(same-host). undo 없음(audit journal).
**의존성**: 신규 0 (russh exec + 기존 SFTP + 기존 password 다이얼로그 재사용).

---

## 1. 문제 / 로컬 UAC 와의 차이

| | 로컬 (UAC, 완료) | 원격 (이 문서) |
|--|--|--|
| 대상 | 클라이언트 Windows | 접속한 SSH **서버** (보통 리눅스) |
| 권한 체계 | Windows UAC | Unix 권한 (root) |
| 승격 | `runas` (진짜 UAC 창) | 서버에서 **`sudo`** |
| 자격증명 | UAC 동의(비번 OS 가 처리) | **sudo 비밀번호**(duet 이 다뤄야 함 §5) |

원격은 클라이언트 OS 와 무관 — Windows 에서 보든 Linux 에서 보든 "서버의 sudo".

## 2. 메커니즘 (SFTP 는 sudo 불가 → exec)

SFTP 는 로그인 사용자 권한으로만 동작(권한 상승 개념 없음). 따라서 exec 채널로
`sudo` 실행. **§9 준수** — russh exec 채널, 시스템 ssh 바이너리 호출 금지.

### 2.1 Local→Remote (보호 경로) — 2단계

```
1. SFTP 로 사용자 쓰기 가능한 staging 에 업로드:
   ~/.duet-sudo/<uuid>/<파일트리>     (홈은 사용자 소유 → SFTP OK)
2. exec: sudo 로 staging → 최종 경로 이동/복사
   sudo -S cp -a -- <staging>/. <dest>/       (또는 mkdir -p 후)
3. staging 정리: rm -rf ~/.duet-sudo/<uuid>   (사용자 소유 → sudo 불필요)
```

### 2.2 Remote→Remote (same-host, 보호 경로) — 직접

```
sudo -S cp -a -- <src> <dst>     (root 가 src 읽고 dst 씀 — staging 불필요)
```

## 3. sudo 비밀번호 (§5 — 가장 중요)

### 3.1 passwordless 먼저 탐지
```
sudo -n true    # -n = non-interactive. exit 0 → NOPASSWD, 비번 불필요.
```
성공하면 비번 프롬프트 없이 바로 실행. 실패면 3.2.

### 3.2 비밀번호 필요 시 (§5 완화 규칙 그대로 재사용)

기존 SSH 비밀번호 인증과 **동일 패턴** (ROADMAP MVP-1: dialog `<input type=password>`
→ IPC → 사용 직후 zeroize):
- FE: `<input type="password">` 다이얼로그. store/localStorage 금지, 컴포넌트 local
  state 만, command 호출 직후 clear.
- IPC: command 인자로 1회 전달. 백엔드는 인자 밖 어디에도 영구화 금지, drop 시 zeroize.
- **로그 출력 절대 금지** (§5).
- **커맨드라인 금지** — `sudo -S` 로 **stdin** 에 비번 주입(`ps` 노출 방지):
  ```
  sudo -S -p '' cp -a -- ...      # -S=stdin에서 비번, -p ''=프롬프트 텍스트 억제
  → exec 채널 stdin 으로 "<password>\n" 전송
  ```

### 3.3 캐시 정책 (결정사항)
- **(가)** 작업마다 프롬프트 (가장 안전, sudo 타임스탬프가 살아있으면 -n 이 통과해 자동 스킵).
- **(나)** 연결 세션 동안 백엔드 메모리 캐시(zeroize) — SSH 비번처럼. 재프롬프트 감소.
- 제안: **(가)** — sudo 자체 타임스탬프(기본 5분)가 이미 캐시 역할을 하므로, 첫 1회만
  물어보고 그 뒤엔 `sudo -n` 이 통과. duet 이 비번을 들고 있을 필요 최소화.

## 4. 트리거 / 감지

- dest 가 **SSH** 이고 복사가 **PermissionDenied**(SFTP `SSH_FX_PERMISSION_DENIED`)로 실패.
- 그때만 "sudo 로 다시 시도?" 다이얼로그. 로컬/기타 에러는 기존 흐름.
- Windows UAC 트리거(로컬 os error 5)와 배타적 — dest 소스로 분기.

## 5. 보안 요약

- sudo 비번: **stdin 전용**(cmdline `ps` 노출 X), 로그 금지, zeroize, 컴포넌트 local + 백엔드
  인자 밖 비영구(§5).
- 경로: 절대경로 + `posix_shell_quote`(기존, fs/ssh.rs) 로 exec 인자 이스케이프.
- staging: 사용자 소유 `~/.duet-sudo/<uuid>`, 작업 후 rm. sudo 로 만든 최종 파일 소유권은
  root(정상 — 서버 관리 파일).
- §9: 모든 것 russh exec/sftp, 시스템 ssh/scp/sftp 바이너리 금지.
- sudo 실패(비번 틀림/권한 없음)는 명확히 에러 표면화, staging 정리.

## 6. IPC 명세 (Tauri command)

```rust
/// 원격 dest 복사가 PermissionDenied 로 실패했을 때 sudo 로 재시도. dest 가 SSH 여야 함.
/// password None = passwordless(-n) 먼저 시도, 필요 시 FE 가 비번 받아 재호출.
#[tauri::command]
async fn fs_copy_execute_sudo(
    plan: CopyPlan,
    policy: ConflictPolicy,
    password: Option<String>,   // §5: 인자 밖 비영구, 사용 직후 zeroize
) -> Result<SudoOutcome, DuetError>;

enum SudoOutcome {
    Ok { count: u32, failed: Vec<String> },
    NeedPassword,     // sudo -n 실패 → FE 가 비번 다이얼로그 후 재호출
    WrongPassword,    // 비번 틀림 → 재입력
}
```

흐름: dest=SSH + PermissionDenied → FE "sudo 재시도" → `fs_copy_execute_sudo(plan, None)`
→ `NeedPassword` 면 비번 다이얼로그 → `fs_copy_execute_sudo(plan, Some(pw))`.

## 7. 레이어 분해

| 레이어 | 파일 | 책임 |
|--------|------|------|
| ssh | `ssh/remote_exec.rs` | **`exec_with_stdin` 신규**(비번 stdin 주입). 확인됨: 기존 `exec` 는 stdin 안 씀이나 russh `Channel::data()`+`eof()` 로 stdin 전송 가능 → feasible |
| fs | `fs/ssh.rs` | `sudo_copy`(staging 업로드 + sudo exec + 정리), `sudo_probe`(-n) |
| core | `core/ops.rs` 또는 `core/sudo.rs` | plan→src/dst 도출, staging 오케스트레이션 |
| commands | `commands/fs_ops.rs` | `fs_copy_execute_sudo` |
| FE | `dialogs/SudoPasswordDialog.tsx`(또는 기존 SSH 비번 다이얼로그 재사용) + fileActions/App | 트리거·비번·재시도 |

## 8. v1 범위 밖 (후속)

- 이동(move)·삭제 sudo 승격.
- 원격 Windows 서버 승격(SSH+UAC — 드묾·복잡).
- sudo undo(되돌리려면 재-sudo).
- doas/기타 su 도구(우선 sudo 만).

## 9. 테스트

- 유닛(크로스플랫폼): sudo 커맨드 조립·이스케이프, staging 경로 계산, 비번을 cmdline 에
  안 넣는지(문자열 검사).
- SSH IT(docker, `scripts/ssh-it.sh`): 컨테이너에 sudo 사용자 구성 → 보호 경로 복사
  성공/비번틀림/passwordless 케이스. (docker 필요 — 현재 로컬 미가용, CI/실기.)
- 비번이 로그/에러 문자열에 안 새는지 검증.

## 10. 미결 질문 (승인 시 확정)

1. **범위**: Local→Remote + Remote→Remote(제안) vs Local→Remote 만 먼저?
2. **비번 캐시**: (가) 매번 프롬프트+sudo 타임스탬프 의존(제안) vs (나) 세션 메모리 캐시?
3. **staging 위치**: `~/.duet-sudo/<uuid>`(제안) vs `/tmp/…`(공유 /tmp 보안 주의)?
4. **sudo 도구**: sudo 만(제안) vs doas 등도?
5. **undo**: audit journal 만(제안, undo 없음)?

## 부록: 왜 필요한가

리눅스 서버에 일반 계정으로 붙어 설정파일(`/etc/nginx/…`)·바이너리(`/usr/local/bin`)를
배포하는 건 흔한 실무. 지금은 permission denied 로 막힘. WinSCP 등도 "sudo/root 권한
전환" 옵션을 제공한다. duet 이 이걸 못 하면 서버 운영 워크플로에 구멍.
