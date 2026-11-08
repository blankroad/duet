/**
 * archive 점검 (opus, C-15) — 아카이브 오류 원문이 explainError 를 거쳐 사용자에게 어떤
 * 한 문장으로 보이는지. 한국어로 바꿔 "영어 원문이 그대로 남는 것" 을 찾는다.
 *
 * - `explained` 표: 쉬운 문장으로 바뀌어야 하는 것 (지금 통과).
 * - `raw` 표: 지금은 "입출력 오류 — <영어 원문>" 으로 나오는 것 (기대 = 한국어 설명, 지금 실패).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { explainError, type HostOs } from "@/lib/error";

beforeAll(async () => {
  await i18n.changeLanguage("ko");
});
afterAll(async () => {
  await i18n.changeLanguage("en");
});

type Case = [os: HostOs, kind: string, message: string, expected: RegExp];

/** 백엔드 원문은 archive.rs / tar_unpack.rs 의 format! 문자열 그대로. */
const explained: Case[] = [
  ["unix", "Io", "zip open: invalid Zip archive: Could not find EOCD", /손상/],
  [
    "unix",
    "Io",
    "zip extract: unsupported Zip archive: Compression method not supported",
    /압축 방식/,
  ],
  ["unix", "NeedPassword", "", /암호/],
  [
    "unix",
    "NotSupported",
    "remote extract supports only zip/tar archives (7z, rar, .gz/.bz2/.xz/.zst are local only)",
    /서버에서 풀 수 없/,
  ],
  [
    "unix",
    "NotSupported",
    "`unzip` is not installed on the remote host",
    /unzip 프로그램이 없/,
  ],
  [
    "unix",
    "Io",
    "archive is damaged or not a tar: unexpected EOF",
    /손상/,
  ],
  ["unix", "Io", "archive writes through a link (a/b)", /폴더 밖/],
  [
    "windows",
    "Io",
    "dir/link: failed to unpack: A required privilege is not held by the client. (os error 1314)",
    /개발자 모드/,
  ],
  [
    "windows",
    "Io",
    "create: The filename, directory name, or volume label syntax is incorrect. (os error 123)",
    /쓸 수 없는 이름/,
  ],
  [
    "windows",
    "Io",
    "create: The filename or extension is too long. (os error 206)",
    /너무 깁니다/,
  ],
  // compress 실패 (권한 000) — Permission denied.
  [
    "unix",
    "Io",
    "open b.txt: Permission denied (os error 13)",
    /권한이 없습니다/,
  ],
];

/** 지금 영어 원문이 그대로 노출되는 아카이브 오류 (재현). */
const raw: Case[] = [
  // zip 압축: 4 GiB 넘는 파일 (zip 2.4.2 write.rs:595) — archive.rs add_to_zip 이 large_file 안 켬.
  [
    "unix",
    "Io",
    "zip write big.bin: Large file option has not been set",
    /4\s?GB|너무 큽니다|큰 파일/,
  ],
  // 압축 대상에 순환 심볼릭 링크 — macOS ELOOP=62, Linux 40.
  [
    "unix",
    "Io",
    "stat proj/up/proj/up/proj: Too many levels of symbolic links (os error 62)",
    /링크/,
  ],
  // repack: browse 폴더를 다 지우고 "아카이브 업데이트".
  ["unix", "Io", "nothing to repack (folder is empty)", /비어/],
  // rar 의 경로 탈출 항목 — zip/tar 와 같은 unsafeArchive 문구여야.
  ["unix", "Io", "unsafe path in rar: ../evil.txt", /폴더 밖/],
  // 압축 이름에 / 가 들어감 (CompressDialog 는 검증 안 함).
  ["unix", "Io", "invalid name: a/b", /쓸 수 없는 이름/],
];

describe("archive-opus C-15: explainError on archive errors (ko)", () => {
  it.each(explained)("%s %s: %s", (os, kind, message, expected) => {
    const r = explainError({ kind, message }, os);
    expect(r.text).toMatch(expected);
  });

  it.fails.each(raw)("archive-16: raw English stays: %s %s: %s", (os, kind, message, expected) => {
    const r = explainError({ kind, message }, os);
    // 기대: 한국어 설명 문장. 현재: "입출력 오류 — <영어 원문>".
    expect(r.text).toMatch(expected);
  });

  it.fails("archive-20: ZipCrypto 틀린 암호가 헤더 검사를 통과(1/256)하면 '파일 손상·다시 받으세요' 로 보인다 — 재입력 기회 없음 (Rust opus_zipcrypto_wrong_password_passing_header_check 의 실제 원문)", () => {
    const r = explainError(
      { kind: "Io", message: "write: corrupt deflate stream" },
      "unix",
    );
    // 기대: 암호가 틀렸을 수 있다는 안내.
    expect(r.text).toMatch(/암호/);
  });

  it.fails("archive-16: 원격 AES zip (unzip exit 81) 은 '압축 방식 미지원 · 7-Zip 으로 푸세요' 로 보인다 — 암호 zip 이라는 사실과 '내 PC 로 복사' 해결책이 빠짐", () => {
    const message =
      "the remote host's unzip cannot extract this zip (AES encryption or an unsupported compression method)";
    const r = explainError({ kind: "NotSupported", message }, "unix");
    // 기대: 서버에서 못 푸니 내 PC 로 복사해서 풀라는 안내(remoteFormat 계열).
    expect(r.text).toMatch(/내 PC/);
  });
});
