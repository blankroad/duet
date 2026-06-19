//! OS별 분기. 상위 레이어는 `commands → platform` 으로만 진입.
//!
//! 외부 프로세스 spawn / OS API 호출은 이 레이어에 격리한다. 각 기능은
//! cfg-gated facade 로 노출해 모든 OS 에서 컴파일되며, 미지원 OS 는
//! `DuetError::NotSupported` 를 돌려준다.

use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

#[cfg(target_os = "macos")]
mod macos;

/// Windows 셸 컨텍스트 verb 1건 (정적 레지스트리 verb). 우클릭 메뉴에 표시.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ShellVerb {
    /// 재실행용 id — `HKCR\<id>\command` 의 기본값을 다시 읽어 spawn.
    pub id: String,
    /// 표시 라벨 (MUIVerb / 기본값 / verb 이름).
    pub label: String,
}

/// 우클릭 대상 종류 — 스캔할 레지스트리 shell 루트를 결정.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ShellScope {
    /// 파일 항목 — `*`, `AllFilesystemObjects`, 확장자 ProgID 등.
    File,
    /// 폴더 항목 — `Directory`, `Folder`.
    Directory,
    /// 폴더 빈 영역 — `Directory\Background`.
    Background,
}

/// 앱 실행파일(`.exe`)의 OS 네이티브 아이콘을 PNG 바이트로 추출.
///
/// Windows: `systemicons`(SHGetFileInfo+GDI). 절대경로 .exe 면 임베드 리소스
/// 아이콘을 반환한다. 그 외 OS: `NotSupported` (프론트는 모노그램 fallback).
/// `size` 는 px (16/32/64 권장).
pub fn app_icon(path: &Path, size: i32) -> Result<Vec<u8>, DuetError> {
    #[cfg(windows)]
    {
        let p = path
            .to_str()
            .ok_or_else(|| DuetError::Io("icon: non-utf8 path".into()))?;
        systemicons::get_icon(p, size)
            .map_err(|e| DuetError::Io(format!("icon extract failed: {e:?}")))
    }
    #[cfg(not(windows))]
    {
        let _ = (path, size);
        Err(DuetError::NotSupported(
            "app icon extraction is only supported on Windows".into(),
        ))
    }
}

/// 마운트된 볼륨/드라이브를 eject (언마운트 + 디바이스 분리).
///
/// - macOS: `diskutil eject <mount>`
/// - Windows: PowerShell Shell.Application 의 "Eject" verb (탐색기의 "꺼내기"와 동일)
/// - Linux: `udisksctl unmount` → `udisksctl power-off` (polkit, root 불필요)
///
/// 새 의존성 없이 OS 표준 도구를 spawn 한다(기존 diskutil/open 패턴과 동일). 비가역
/// 시스템 op 라 journal/undo 대상이 아니며, 안전장치는 frontend 확인 다이얼로그다.
pub fn eject_volume(path: &Path) -> Result<(), DuetError> {
    #[cfg(target_os = "macos")]
    {
        macos::eject_volume(path)
    }
    #[cfg(target_os = "windows")]
    {
        windows_eject(path)
    }
    #[cfg(target_os = "linux")]
    {
        linux_eject(path)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err(DuetError::NotSupported(
            "volume eject is not supported on this OS".into(),
        ))
    }
}

/// 지정 폴더에서 OS 터미널을 연다 (로컬 경로). 우클릭 "여기서 터미널 열기".
///
/// - macOS: `open -a Terminal <dir>`
/// - Windows: Windows Terminal(`wt.exe -d <dir>`), 없으면 `cmd` 새 창(해당 폴더 cwd)
/// - Linux: `$TERMINAL` → 흔한 터미널(x-terminal-emulator/gnome-terminal/… ) 순차 시도
///
/// 새 의존성 없이 OS 표준 도구를 spawn(기존 eject/open 패턴과 동일). 셸을 띄우는 것뿐이라
/// journal/undo 대상이 아니다. 비-디렉토리/원격은 호출자(command)가 거른다.
pub fn open_terminal(dir: &Path) -> Result<(), DuetError> {
    #[cfg(target_os = "macos")]
    {
        macos_open_terminal(dir)
    }
    #[cfg(target_os = "windows")]
    {
        windows_open_terminal(dir)
    }
    #[cfg(target_os = "linux")]
    {
        linux_open_terminal(dir)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = dir;
        Err(DuetError::NotSupported(
            "open terminal is not supported on this OS".into(),
        ))
    }
}

#[cfg(target_os = "macos")]
fn macos_open_terminal(dir: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    let status = Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(dir)
        .status()
        .map_err(|e| DuetError::Io(format!("open terminal: spawn failed: {e}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(DuetError::Io(
            "open terminal: 'open -a Terminal' failed".into(),
        ))
    }
}

#[cfg(target_os = "windows")]
fn windows_open_terminal(dir: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    // 1) Windows Terminal 우선 — `-d <dir>` 로 시작 폴더 지정.
    if Command::new("wt.exe").arg("-d").arg(dir).spawn().is_ok() {
        return Ok(());
    }
    // 2) 폴백: 새 cmd 창. start 가 새 콘솔을 띄우고, cwd 는 current_dir 로 상속(인용 이슈 회피).
    Command::new("cmd")
        .args(["/c", "start", "cmd"])
        .current_dir(dir)
        .spawn()
        .map_err(|e| DuetError::Io(format!("open terminal: cmd spawn failed: {e}")))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_open_terminal(dir: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    // 대부분의 터미널은 spawn 의 cwd(current_dir)를 상속해 그 폴더에서 시작한다.
    let try_spawn = |bin: &str| Command::new(bin).current_dir(dir).spawn().is_ok();
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.is_empty() && try_spawn(&t) {
            return Ok(());
        }
    }
    for bin in [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "alacritty",
        "kitty",
        "xterm",
    ] {
        if try_spawn(bin) {
            return Ok(());
        }
    }
    Err(DuetError::NotSupported(
        "open terminal: no known terminal emulator found".into(),
    ))
}

// ── Windows 셸 컨텍스트 verb (정적 레지스트리) ───────────────────────────────
// Explorer/Total Commander 처럼 레지스트리의 `…\shell\<verb>` 정적 verb 를 읽어 우클릭
// 메뉴에 노출한다. COM 핸들러(`shellex\ContextMenuHandlers`, 7-Zip 등)는 Tier-2 이며 미포함.
// Windows 외엔 빈 목록 / NotSupported.

/// 우클릭 대상의 정적 셸 verb 목록. Windows 외에선 빈 벡터.
pub fn shell_context_verbs(scope: ShellScope, path: &Path) -> Vec<ShellVerb> {
    #[cfg(windows)]
    {
        win_shell_verbs(scope, path)
    }
    #[cfg(not(windows))]
    {
        let _ = (scope, path);
        Vec::new()
    }
}

/// 선택한 verb 실행 — `HKCR\<id>\command` 를 읽어 경로 치환 후 spawn. Windows 전용.
pub fn shell_context_invoke(id: &str, scope: ShellScope, path: &Path) -> Result<(), DuetError> {
    #[cfg(windows)]
    {
        win_shell_invoke(id, scope, path)
    }
    #[cfg(not(windows))]
    {
        let _ = (id, scope, path);
        Err(DuetError::NotSupported(
            "shell context verbs are Windows-only".into(),
        ))
    }
}

/// 셸 command 문자열 → argv. Windows 따옴표 규칙 간소화: `"` 로 묶인 구간은 공백 보존.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_command_line(s: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut has = false;
    for c in s.chars() {
        match c {
            '"' => {
                in_q = !in_q;
                has = true;
            }
            c if c.is_whitespace() && !in_q => {
                if has {
                    args.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        args.push(cur);
    }
    args
}

/// `%VAR%`(환경변수)만 확장. 셸 placeholder(`%1`,`%V`,…)는 그대로 둔다(숫자/단일문자라
/// `%이름%` 패턴에 안 걸림). lookup 이 None 이면 원문 유지.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn expand_env_vars(s: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after.find('%') {
            let name = &after[..end];
            let is_var = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '(' || c == ')')
                && !name.chars().next().unwrap().is_ascii_digit();
            if is_var {
                if let Some(v) = lookup(name) {
                    out.push_str(&v);
                    rest = &after[end + 1..];
                    continue;
                }
            }
        }
        // 변수 아님 — `%` 한 글자만 흘려보내고 계속.
        out.push('%');
        rest = after;
    }
    out.push_str(rest);
    out
}

/// argv 의 셸 placeholder 치환 — `%1/%L/%D/%V`→item, `%W`→workdir, `%*`,`%~`→제거.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn substitute_placeholders(argv: Vec<String>, item: &str, workdir: &str) -> Vec<String> {
    let mut out = Vec::new();
    for a in argv {
        if a == "%*" || a == "%~" {
            continue; // 모든 인자 — 단일 아이템엔 무의미
        }
        let r = a
            .replace("%1", item)
            .replace("%L", item)
            .replace("%l", item)
            .replace("%V", item)
            .replace("%v", item)
            .replace("%D", item)
            .replace("%d", item)
            .replace("%W", workdir)
            .replace("%w", workdir);
        out.push(r);
    }
    out
}

/// 메뉴 라벨에서 `&` 가속기 제거 ("E&dit" → "Edit", "&&" → "&").
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn strip_accelerator(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
            // 단일 '&' 는 가속기 표시 — 버림
        } else {
            out.push(c);
        }
    }
    out
}

/// verb 키 이름을 표시용으로 ("open" → "Open").
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// 표시 라벨 선택 — MUIVerb → 기본값 → verb 이름 순. `@dll,-id` 인다이렉트는 호출 측
/// (win_verb_label)에서 SHLoadIndirectString 로 미리 해석해 넘기므로, 여기 도달하는
/// 값은 평문이다. 그래도 해석 실패한 `@` 잔여는 한 번 더 건너뛴다.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn pick_label(muiverb: Option<&str>, default: Option<&str>, verb: &str) -> String {
    for cand in [muiverb, default].into_iter().flatten() {
        let c = cand.trim();
        if !c.is_empty() && !c.starts_with('@') {
            return strip_accelerator(c);
        }
    }
    capitalize_first(verb)
}

/// `AppliesTo` 조건부 verb 의 근사 평가 — 확장자 기반만 본다. 쿼리에 파일 확장자가
/// 들어 있으면 적용으로 간주, 그 외(속성/종류 기반 등 평가 불가)는 false(숨김)로
/// false-positive 를 줄인다 — "탐색기엔 없는데 뜨는" 항목 감소. ext=None 이면 false.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn applies_to_matches(applies_to: &str, ext: Option<&str>) -> bool {
    match ext {
        Some(e) if !e.is_empty() => {
            let needle = format!(".{}", e.to_ascii_lowercase());
            applies_to.to_ascii_lowercase().contains(&needle)
        }
        _ => false,
    }
}

#[cfg(windows)]
fn win_scope_shell_keys(scope: ShellScope, path: &Path) -> Vec<String> {
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    match scope {
        ShellScope::Background => vec!["Directory\\Background\\shell".to_string()],
        ShellScope::Directory => vec![
            "Directory\\shell".to_string(),
            "Folder\\shell".to_string(),
            "AllFilesystemObjects\\shell".to_string(),
        ],
        ShellScope::File => {
            let mut keys = vec![
                "*\\shell".to_string(),
                "AllFilesystemObjects\\shell".to_string(),
            ];
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let dotext = format!(".{}", ext.to_ascii_lowercase());
                keys.push(format!("SystemFileAssociations\\{dotext}\\shell"));
                if let Ok(progid) = RegKey::predef(HKEY_CLASSES_ROOT)
                    .open_subkey(&dotext)
                    .and_then(|k| k.get_value::<String, _>(""))
                {
                    if !progid.is_empty() {
                        keys.push(format!("{progid}\\shell"));
                    }
                }
            }
            keys
        }
    }
}

// SHLoadIndirectString(shlwapi) — `@dll,-id` 인다이렉트 리소스 문자열을 실제 표시명으로.
// `windows` 크레이트 없이 raw FFI 로 선언(새 의존성 회피, 시스템 DLL 링크만). §8: unsafe 는 platform/ 한정.
#[cfg(windows)]
#[link(name = "shlwapi")]
extern "system" {
    fn SHLoadIndirectString(
        psz_source: *const u16,
        pszout_buf: *mut u16,
        cchout_buf: u32,
        ppv_reserved: *mut *mut core::ffi::c_void,
    ) -> i32; // HRESULT (S_OK == 0)
}

/// `@<file>,-<id>` 인다이렉트 문자열 → 실제 표시명. 실패 시 None.
#[cfg(windows)]
fn resolve_indirect_string(s: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    let src: Vec<u16> = std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut buf = vec![0u16; 512];
    // SAFETY: src 는 널종단 UTF-16 포인터, buf 는 cchout_buf(=buf.len()) 만큼 쓰기 가능,
    // reserved 는 null. MS 문서 계약 준수. 실패하면 HRESULT != 0 로 분기.
    let hr = unsafe {
        SHLoadIndirectString(
            src.as_ptr(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            std::ptr::null_mut(),
        )
    };
    if hr != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let out = String::from_utf16_lossy(&buf[..len]);
    let t = out.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// 레지스트리 라벨값 정리 — `@` 인다이렉트면 해석 시도(실패 시 None), 평문이면 그대로.
#[cfg(windows)]
fn clean_reg_label(v: Option<String>) -> Option<String> {
    let v = v?;
    let t = v.trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with('@') {
        resolve_indirect_string(t) // 해석 실패면 None → pick_label 이 다음 후보/verb 이름으로
    } else {
        Some(t.to_string())
    }
}

#[cfg(windows)]
fn win_verb_label(vk: &winreg::RegKey, verb: &str) -> String {
    let mui = clean_reg_label(vk.get_value::<String, _>("MUIVerb").ok());
    let def = clean_reg_label(vk.get_value::<String, _>("").ok());
    pick_label(mui.as_deref(), def.as_deref(), verb)
}

#[cfg(windows)]
fn win_shell_verbs(scope: ShellScope, path: &Path) -> Vec<ShellVerb> {
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
    // 파일 scope 일 때만 확장자 — AppliesTo 조건부 verb 평가용.
    let ext = match scope {
        ShellScope::File => path.extension().and_then(|e| e.to_str()),
        _ => None,
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for shell_key in win_scope_shell_keys(scope, path) {
        let Ok(sk) = hkcr.open_subkey(&shell_key) else {
            continue;
        };
        for verb in sk.enum_keys().flatten() {
            let Ok(vk) = sk.open_subkey(&verb) else {
                continue;
            };
            // 숨김/프로그램전용/Shift전용(Extended) verb 제외 — Explorer 기본 메뉴와 맞춤.
            if vk.get_value::<String, _>("LegacyDisable").is_ok()
                || vk.get_value::<String, _>("ProgrammaticAccessOnly").is_ok()
                || vk.get_value::<String, _>("Extended").is_ok()
            {
                continue;
            }
            // AppliesTo 조건부 verb — 확장자 매칭 안 되면 숨김(탐색기 미표시 항목 감소).
            if let Ok(applies) = vk.get_value::<String, _>("AppliesTo") {
                if !applies_to_matches(&applies, ext) {
                    continue;
                }
            }
            // `command` 기본값이 있어야 spawn 가능 (DelegateExecute-only COM verb 제외).
            let has_cmd = vk
                .open_subkey("command")
                .and_then(|c| c.get_value::<String, _>(""))
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if !has_cmd {
                continue;
            }
            let label = win_verb_label(&vk, &verb);
            if label.is_empty() || !seen.insert(label.to_ascii_lowercase()) {
                continue; // 빈/중복 라벨 스킵
            }
            out.push(ShellVerb {
                id: format!("{shell_key}\\{verb}"),
                label,
            });
        }
    }
    out
}

#[cfg(windows)]
fn win_shell_invoke(id: &str, scope: ShellScope, path: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    use winreg::enums::HKEY_CLASSES_ROOT;
    use winreg::RegKey;
    let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
    let template: String = hkcr
        .open_subkey(format!("{id}\\command"))
        .and_then(|c| c.get_value(""))
        .map_err(|e| DuetError::Io(format!("shell verb command read: {e}")))?;
    let expanded = expand_env_vars(&template, &|n| std::env::var(n).ok());
    let item = path.to_string_lossy().into_owned();
    let workdir = match scope {
        ShellScope::File => path
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        ShellScope::Directory | ShellScope::Background => item.clone(),
    };
    let argv = substitute_placeholders(parse_command_line(&expanded), &item, &workdir);
    if argv.is_empty() {
        return Err(DuetError::Io("shell verb: empty command".into()));
    }
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    if !workdir.is_empty() {
        cmd.current_dir(&workdir);
    }
    cmd.spawn()
        .map_err(|e| DuetError::Io(format!("shell verb spawn: {e}")))?;
    Ok(())
}

/// Windows: 볼륨 경로(`E:\`)에서 드라이브 토큰(`E:`) 추출. 드라이브 문자 형식만 허용.
#[cfg(any(target_os = "windows", test))]
fn windows_drive_token(path: &Path) -> Option<String> {
    let s = path.to_str()?;
    let b = s.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        Some(format!("{}:", (b[0] as char).to_ascii_uppercase()))
    } else {
        None
    }
}

/// Windows: Shell.Application "Eject" verb 를 호출하는 PowerShell 스크립트.
/// Namespace(17) = ssfDRIVES(내 PC). `drive` 는 검증된 `X:` 형식이라 인젝션 안전.
#[cfg(any(target_os = "windows", test))]
fn windows_eject_script(drive: &str) -> String {
    format!(
        "$ErrorActionPreference='Stop'; (New-Object -ComObject Shell.Application).Namespace(17).ParseName('{drive}').InvokeVerb('Eject')"
    )
}

#[cfg(target_os = "windows")]
fn windows_eject(path: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    let drive = windows_drive_token(path)
        .ok_or_else(|| DuetError::Io(format!("eject: not a drive path: {}", path.display())))?;
    let script = windows_eject_script(&drive);
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| DuetError::Io(format!("eject: powershell spawn failed: {e}")))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(DuetError::Io(format!(
            "eject failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

/// Linux: `/proc/mounts` 의 octal escape(`\040` 등) 디코딩.
#[cfg(any(target_os = "linux", test))]
fn unescape_proc_mounts(field: &str) -> String {
    let mut out = String::with_capacity(field.len());
    let mut chars = field.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '\\' && field.len() >= i + 4 {
            let oct = &field[i + 1..i + 4];
            if let Ok(n) = u8::from_str_radix(oct, 8) {
                out.push(n as char);
                chars.next();
                chars.next();
                chars.next();
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// Linux: `/proc/mounts` 내용에서 주어진 mountpoint 의 device 경로를 찾는다.
#[cfg(any(target_os = "linux", test))]
fn linux_device_for_mount(mounts: &str, mountpoint: &Path) -> Option<String> {
    let target = mountpoint.to_str()?;
    for line in mounts.lines() {
        let mut it = line.split_whitespace();
        let dev = it.next()?;
        let mp = it.next()?;
        if unescape_proc_mounts(mp) == target {
            return Some(dev.to_string());
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_eject(path: &Path) -> Result<(), DuetError> {
    use std::process::Command;
    let mounts = std::fs::read_to_string("/proc/mounts")
        .map_err(|e| DuetError::Io(format!("eject: read /proc/mounts: {e}")))?;
    let dev = linux_device_for_mount(&mounts, path)
        .ok_or_else(|| DuetError::Io(format!("eject: no device for mount {}", path.display())))?;
    // unmount (polkit — root 불필요). 실패 시 중단.
    let out = Command::new("udisksctl")
        .args(["unmount", "-b", &dev])
        .output()
        .map_err(|e| DuetError::Io(format!("eject: udisksctl spawn failed (설치 필요?): {e}")))?;
    if !out.status.success() {
        return Err(DuetError::Io(format!(
            "eject(unmount) failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    // power-off (USB 안전제거) — 네트워크/일부 디바이스는 미지원이라 best-effort.
    let _ = Command::new("udisksctl")
        .args(["power-off", "-b", &dev])
        .output();
    Ok(())
}

// === Windows 탐색기 통합: 폴더/드라이브 우클릭 "Open in duet" ===
//
// HKCU\Software\Classes 아래 사용자 범위로만 기록(관리자 불필요). 우리가 만든
// 3개 키(Directory / Directory\Background / Drive 의 shell\duet)만 다루고,
// 해제는 그 키만 재귀 삭제 — 완전 가역. 레지스트리 경로는 파일시스템 경로가
// 아니라 항상 `\` 구분자(§7 무관).

/// "Open in duet" 우클릭 항목이 등록돼 있는지. 비-Windows 는 항상 false.
pub fn open_in_duet_status() -> Result<bool, DuetError> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        Ok(hkcu
            .open_subkey(r"Software\Classes\Directory\shell\duet\command")
            .is_ok())
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// "Open in duet" 우클릭 항목 등록(멱등). `exe` = 현재 실행파일 — 클릭한 폴더를
/// `%1`(Drive/Directory) / `%V`(Background) 로 전달받는다.
pub fn open_in_duet_register(exe: &Path) -> Result<(), DuetError> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| DuetError::Io("exe path non-utf8".into()))?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // (base 키, command 가 폴더를 받는 토큰)
        let targets = [
            (r"Software\Classes\Directory\shell\duet", "%1"),
            (r"Software\Classes\Directory\Background\shell\duet", "%V"),
            (r"Software\Classes\Drive\shell\duet", "%1"),
        ];
        for (base, arg) in targets {
            let (key, _) = hkcu.create_subkey(base)?;
            key.set_value("", &"Open in duet")?; // 메뉴 라벨
            key.set_value("Icon", &exe_str)?; // 메뉴 아이콘 = duet exe
            let (cmd, _) = hkcu.create_subkey(format!(r"{base}\command"))?;
            cmd.set_value("", &format!("\"{exe_str}\" \"{arg}\""))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        Err(DuetError::NotSupported(
            "shell integration is only supported on Windows".into(),
        ))
    }
}

/// "Open in duet" 우클릭 항목 해제 — 우리가 만든 3개 키만 재귀 삭제(없으면 무시).
pub fn open_in_duet_unregister() -> Result<(), DuetError> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for base in [
            r"Software\Classes\Directory\shell\duet",
            r"Software\Classes\Directory\Background\shell\duet",
            r"Software\Classes\Drive\shell\duet",
        ] {
            let _ = hkcu.delete_subkey_all(base); // 없으면 Err — 무시(가역·멱등)
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_command_line_respects_quotes() {
        assert_eq!(
            parse_command_line(r#""C:\Program Files\App\app.exe" "%1""#),
            vec![
                r"C:\Program Files\App\app.exe".to_string(),
                "%1".to_string()
            ],
        );
        assert_eq!(
            parse_command_line("notepad.exe %1"),
            vec!["notepad.exe".to_string(), "%1".to_string()],
        );
        assert_eq!(
            parse_command_line(r#"cmd /s /k pushd "%V""#),
            vec![
                "cmd".to_string(),
                "/s".to_string(),
                "/k".to_string(),
                "pushd".to_string(),
                "%V".to_string()
            ],
        );
    }

    #[test]
    fn expand_env_vars_only_touches_named_vars() {
        let look = |n: &str| match n {
            "SystemRoot" => Some(r"C:\Windows".to_string()),
            _ => None,
        };
        assert_eq!(
            expand_env_vars(r"%SystemRoot%\system32\cmd.exe", &look),
            r"C:\Windows\system32\cmd.exe",
        );
        // placeholder 는 그대로.
        assert_eq!(expand_env_vars(r#""%1""#, &look), r#""%1""#);
        // 미지의 변수는 원문 유지.
        assert_eq!(expand_env_vars("%NOPE%", &look), "%NOPE%");
    }

    #[test]
    fn substitute_placeholders_maps_item_and_workdir() {
        let argv = vec![
            "app.exe".to_string(),
            "%1".to_string(),
            "/dir:%W".to_string(),
            "%*".to_string(),
        ];
        assert_eq!(
            substitute_placeholders(argv, r"C:\f.txt", r"C:\"),
            vec![
                "app.exe".to_string(),
                r"C:\f.txt".to_string(),
                r"/dir:C:\".to_string()
            ],
        );
    }

    #[test]
    fn strip_accelerator_and_capitalize() {
        assert_eq!(strip_accelerator("E&dit"), "Edit");
        assert_eq!(strip_accelerator("Scan && clean"), "Scan & clean");
        assert_eq!(capitalize_first("open"), "Open");
        assert_eq!(capitalize_first("runas"), "Runas");
    }

    #[test]
    fn applies_to_extension_match() {
        // 확장자 기반 AppliesTo — 매칭/불매칭.
        assert!(applies_to_matches(
            r#"System.FileName:"*.png" OR System.FileName:"*.jpg""#,
            Some("png")
        ));
        assert!(!applies_to_matches(
            r#"System.FileName:"*.png""#,
            Some("txt")
        ));
        // 속성/종류 기반(확장자 없음) → 평가 불가 → 숨김(false).
        assert!(!applies_to_matches("System.Kind:=picture", Some("png")));
        // 확장자 없음 → false.
        assert!(!applies_to_matches(r#"System.FileName:"*.png""#, None));
    }

    #[test]
    fn pick_label_skips_indirect_strings() {
        // 평범한 MUIVerb 사용.
        assert_eq!(
            pick_label(Some("Open with &Code"), None, "open"),
            "Open with Code"
        );
        // MUIVerb 가 @인다이렉트 → 기본값으로.
        assert_eq!(
            pick_label(Some(r"@C:\app.exe,-101"), Some("Edit"), "edit"),
            "Edit"
        );
        // 둘 다 @인다이렉트(또는 없음) → verb 이름 폴백 (@경로 그대로 노출 금지).
        assert_eq!(
            pick_label(Some(r"@shell32.dll,-8506"), Some(r"@C:\x.dll,-5"), "runas"),
            "Runas"
        );
        assert_eq!(pick_label(None, None, "pintohome"), "Pintohome");
    }

    #[test]
    fn windows_drive_token_extracts_letter() {
        assert_eq!(
            windows_drive_token(Path::new("E:\\")).as_deref(),
            Some("E:")
        );
        assert_eq!(windows_drive_token(Path::new("e:")).as_deref(), Some("E:"));
        assert_eq!(
            windows_drive_token(Path::new("C:\\Users")).as_deref(),
            Some("C:")
        );
        assert_eq!(windows_drive_token(Path::new("/Volumes/x")), None);
        assert_eq!(windows_drive_token(Path::new("\\\\server\\share")), None);
    }

    #[test]
    fn windows_eject_script_targets_drive() {
        let s = windows_eject_script("E:");
        assert!(s.contains("Shell.Application"));
        assert!(s.contains("ParseName('E:')"));
        assert!(s.contains("InvokeVerb('Eject')"));
    }

    #[test]
    fn proc_mounts_unescape_decodes_octal() {
        assert_eq!(
            unescape_proc_mounts("/media/u/My\\040Disk"),
            "/media/u/My Disk"
        );
        assert_eq!(unescape_proc_mounts("/mnt/data"), "/mnt/data");
        assert_eq!(unescape_proc_mounts("a\\134b"), "a\\b"); // \134 = backslash
    }

    #[test]
    fn linux_device_for_mount_resolves() {
        let mounts = "\
/dev/sda1 / ext4 rw 0 0
/dev/sdb1 /media/u/My\\040Disk vfat rw 0 0
tmpfs /run tmpfs rw 0 0
";
        assert_eq!(
            linux_device_for_mount(mounts, Path::new("/media/u/My Disk")).as_deref(),
            Some("/dev/sdb1")
        );
        assert_eq!(
            linux_device_for_mount(mounts, Path::new("/")).as_deref(),
            Some("/dev/sda1")
        );
        assert_eq!(linux_device_for_mount(mounts, Path::new("/nope")), None);
    }
}
