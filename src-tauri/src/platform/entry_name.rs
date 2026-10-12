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
}
