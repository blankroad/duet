//! New local entry name validation; Windows path rules stay in the platform layer.

use crate::types::DuetError;

/// Validate one local child name, including Windows reserved names on Windows.
pub fn validate_local_name(name: &str) -> Result<(), DuetError> {
    validate_name(name, cfg!(windows))
}

fn validate_name(name: &str, windows: bool) -> Result<(), DuetError> {
    let invalid = name.trim().is_empty()
        || matches!(name, "." | "..")
        || name.contains(['/', '\\', '\0'])
        || (windows
            && (name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
                || name.ends_with(['.', ' '])
                || reserved_windows_name(name)));
    if invalid {
        return Err(DuetError::Io("invalid entry name".into()));
    }
    Ok(())
}

/// 아카이브 안의 이름 한 칸을 이 OS 에서 만들 수 있는 이름으로 바꾼다 (7-Zip 과 같은 방식).
/// Windows: `<>:"|?*\`·제어문자 → `_`, 끝의 `.`/공백 → `_`, 예약 이름(CON 등) 앞에 `_`.
/// 다른 OS 는 그대로 — 거기선 `/` 와 NUL 외에는 모두 쓸 수 있고, `/` 는 호출부가 이미 나눴다.
pub fn sanitize_local_name(name: &str) -> std::borrow::Cow<'_, str> {
    sanitize_name(name, cfg!(windows))
}

fn sanitize_name(name: &str, windows: bool) -> std::borrow::Cow<'_, str> {
    if !windows || validate_name(name, true).is_ok() {
        return std::borrow::Cow::Borrowed(name);
    }
    let mut out: String = name
        .chars()
        .map(|c| {
            if c < ' ' || "<>:\"|?*\\".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // 끝의 `.`·공백 연속 구간을 같은 개수의 `_` 로 (둘 다 1바이트라 바이트 수 = 글자 수).
    let kept = out.trim_end_matches(['.', ' ']).len();
    let tail = out.len() - kept;
    out.truncate(kept);
    out.extend(std::iter::repeat_n('_', tail));
    if reserved_windows_name(&out) {
        out.insert(0, '_');
    }
    std::borrow::Cow::Owned(out)
}

fn reserved_windows_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_and_windows_reserved_names() {
        for name in ["", " ", ".", "..", "a/b", "..\\outside", "a\0b"] {
            assert!(validate_name(name, false).is_err());
        }
        for name in ["CON.txt", "lpt1", "COM².log", "a:", "name.", "name "] {
            assert!(validate_name(name, true).is_err());
        }
        for name in ["검증 파일.txt", ".env", "company.txt"] {
            assert!(validate_name(name, true).is_ok());
        }
        assert!(validate_name("remote:name", false).is_ok());
    }

    #[test]
    fn sanitizes_names_windows_cannot_create() {
        let cases = [
            ("log 10:00.txt", "log 10_00.txt"),
            ("a<b>c|d?e*f\"g", "a_b_c_d_e_f_g"),
            ("back\\slash", "back_slash"),
            ("trailing.", "trailing_"),
            ("trailing ", "trailing_"),
            ("CON.txt", "_CON.txt"),
            ("aux", "_aux"),
            ("tab\there", "tab_here"),
        ];
        for (input, want) in cases {
            let got = sanitize_name(input, true);
            assert_eq!(got, want, "{input}");
            assert!(validate_name(&got, true).is_ok(), "{got}");
        }
        for ok in ["검증 파일.txt", ".env", "company.txt"] {
            assert!(matches!(
                sanitize_name(ok, true),
                std::borrow::Cow::Borrowed(_)
            ));
        }
        // 다른 OS 는 손대지 않는다.
        assert_eq!(sanitize_name("log 10:00.txt", false), "log 10:00.txt");
    }
}
