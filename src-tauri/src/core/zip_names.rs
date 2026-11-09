//! zip 항목 이름의 문자 인코딩 판정 (archive-04 / U-05).
//!
//! zip 은 이름이 UTF-8 이라는 표시(플래그 11)가 없으면 원래 CP437 로 읽는다. 한국어
//! Windows 탐색기·국내 압축 도구는 표시 없이 CP949 바이트를 쓰는 일이 흔해서, 그대로 읽으면
//! `한글.txt` 가 `╟╤▒█.txt` 로 깨진다. 여기서는 사용자 결정 D-4("휴리스틱 자동")대로:
//! - 이름 바이트가 UTF-8 로 유효하면 zip crate 가 읽은 이름을 그대로 쓴다
//!   (플래그 11·Info-ZIP Unicode Path extra 가 적용된 이름도 여기에 든다 — zip 9 는
//!   extra 를 적용할 때 원시 이름을 UTF-8 로 바꿔 둔다).
//! - UTF-8 로 무효인데 CP949(WHATWG `EUC-KR` = windows-949)로 오류 없이 풀리면 그 결과.
//! - 둘 다 아니면 zip crate 의 결과(CP437)를 그대로.
//!
//! Shift-JIS 바이트도 CP949 로 "유효하게" 풀리는 경우가 많아 구분할 수 없다 — 한국어 사용자가
//! 주 대상이라 CP949 를 고른다(Shift-JIS zip 은 범위 밖, 기기 확인 목록).

use std::borrow::Cow;

/// 항목의 원시 이름 바이트(`ZipFile::name_raw`)와 zip crate 가 읽은 이름(`ZipFile::name`)으로
/// 화면·디스크에 쓸 이름을 고른다. 판정 규칙은 모듈 설명 참조.
pub fn decode_entry_name<'a>(raw: &[u8], decoded: Cow<'a, str>) -> Cow<'a, str> {
    if std::str::from_utf8(raw).is_ok() {
        return decoded;
    }
    match encoding_rs::EUC_KR.decode_without_bom_handling_and_without_replacement(raw) {
        Some(name) => Cow::Owned(name.into_owned()),
        None => decoded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// zip crate 의 CP437 해석 대신 넣어 둔 자리표시자 — 규칙상 쓰이면 안 되는 경우를 가린다.
    fn cp437() -> Cow<'static, str> {
        Cow::Borrowed("<cp437>")
    }

    #[test]
    fn cp949_bytes_without_utf8_flag_become_hangul() {
        // "보고서 2024/결과.xlsx" 의 CP949 바이트.
        let mut raw = vec![186, 184, 176, 237, 188, 173];
        raw.extend_from_slice(b" 2024/");
        raw.extend_from_slice(&[176, 225, 176, 250]);
        raw.extend_from_slice(b".xlsx");
        assert_eq!(decode_entry_name(&raw, cp437()), "보고서 2024/결과.xlsx");
        // UHC 확장 영역(완성형 밖 글자) — "똠방각하" 의 '똠'.
        assert_eq!(decode_entry_name(&[0x8C, 0x63], cp437()), "똠");
    }

    #[test]
    fn utf8_and_ascii_names_keep_the_zip_decoding() {
        let utf8 = "한글.txt";
        assert_eq!(
            decode_entry_name(utf8.as_bytes(), Cow::Borrowed(utf8)),
            utf8
        );
        assert_eq!(
            decode_entry_name(b"plain/readme.txt", Cow::Borrowed("plain/readme.txt")),
            "plain/readme.txt"
        );
    }

    #[test]
    fn bytes_invalid_in_both_keep_the_zip_decoding() {
        // 0xFF 는 UTF-8·CP949 어디서도 글자가 아니다.
        assert_eq!(decode_entry_name(&[0xFF, b'a'], cp437()), "<cp437>");
    }
}
