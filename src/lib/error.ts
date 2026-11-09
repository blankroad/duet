import { platform } from "@tauri-apps/plugin-os";
import i18n from "@/i18n";
import { basename } from "@/lib/paths";
import type { DuetError } from "@/types/bindings";

/**
 * 백엔드 오류를 사용자가 읽을 수 있는 말로.
 *
 * 백엔드 원문("failed to unpack `a` into `C:\…`: … (os error 1314)")은 개발자용이라
 * 사용자는 무슨 일인지, 무엇을 하면 되는지 알 수 없었다. 여기서
 * 1) 오류 종류(kind), 2) **이 PC 의** OS 오류 번호, 3) 메시지 패턴(압축 손상 등)으로
 * 원인을 골라 "무엇이 왜 · 어떻게" 한 문장(`text`)을 만들고, 원문은 `detail` 로 남긴다
 * (알림 목록의 "자세히").
 *
 * 원문에 대상 경로가 있으면 그 이름(basename)을 문장 앞에 붙여 "어느 파일이" 실패했는지
 * 남긴다. 패턴·번호는 경로를 뺀 나머지에만 적용한다 — 파일 이름에 "bad header" 같은 말이
 * 있어도 원인을 잘못 고르지 않게.
 *
 * OS 오류 번호는 OS 마다 뜻이 다르다(1 = Windows "지원 안 되는 기능" / Unix EPERM,
 * 36 = Linux ENAMETOOLONG / macOS EINPROGRESS). "(os error N)" 은 로컬 Rust io 오류에만
 * 붙으므로 이 PC 의 OS 로 해석한다. 원격 명령(kind `Ssh`)의 번호는 서버 OS 것이라 쓰지 않는다.
 */

/** `unix` = OS 를 특정하지 못한 Unix 계열 — macOS·Linux 에서 뜻이 같은 번호만 해석한다. */
export type HostOs = "windows" | "macos" | "linux" | "unix";

export interface ExplainedError {
  /** 사용자에게 보일 한 문장 (현재 언어). */
  text: string;
  /** 백엔드 원문 — 문제 보고·자세히 보기용. 없으면 빈 문자열. */
  detail: string;
  /**
   * 원문에서 찾은 실패 대상 이름(basename) — 실제로 실패한 항목. 있으면 호출부가 아는
   * 대상(예: 선택한 상위 폴더)의 이름을 문장에 또 붙이지 않는다(`errorToastText`).
   */
  target?: string;
}

/** 원인 키 → `errors.reason.<key>` 문구. */
type Reason =
  | "needPassword"
  | "authFailed"
  | "cancelled"
  | "crossDevice"
  | "hostKey"
  | "notPermitted"
  | "remoteMissingProgram"
  | "remoteFormat"
  | "unsafeArchive"
  | "zipMethod"
  | "damagedArchive"
  | "linkPrivilege"
  | "invalidName"
  | "nameTooLong"
  | "diskFull"
  | "inUse"
  | "readOnly"
  | "accessDenied"
  | "notFound"
  | "exists"
  | "notEmpty"
  | "linkLoop"
  | "zipLargeFile"
  | "repackEmpty"
  | "remoteZipUnsupported"
  | "remoteExit"
  | "syncCrossHost"
  | "deviceNotReady"
  | "networkLogon"
  | "virus"
  | "cloudFile"
  | "connRefused"
  | "connTimeout"
  | "connUnreachable"
  | "connDns"
  | "connReset"
  | "network"
  | "unsupportedOp"
  | "connection";

/** 원인만으로는 상황이 갈리는 것 — 원문 요약을 뒤에 붙인다. */
const APPEND_DETAIL = new Set<Reason>(["connection"]);

/** macOS·Linux 에서 뜻이 같은 번호. */
const UNIX_CODES: Record<number, Reason> = {
  1: "accessDenied", // EPERM (macOS 보호 폴더 등)
  2: "notFound",
  13: "accessDenied",
  16: "inUse", // EBUSY
  17: "exists",
  26: "inUse", // ETXTBSY
  28: "diskFull",
  30: "readOnly", // EROFS
};

/** OS 오류 번호 → 원인. 번호의 뜻이 OS 마다 달라 표를 나눈다. */
const OS_CODES: Record<HostOs, Record<number, Reason>> = {
  windows: {
    1: "unsupportedOp", // ERROR_INVALID_FUNCTION (RAM 디스크·일부 가상 드라이브)
    2: "notFound",
    3: "notFound",
    5: "accessDenied",
    19: "readOnly", // ERROR_WRITE_PROTECT
    21: "deviceNotReady", // ERROR_NOT_READY (빠진 USB·빈 광학 드라이브)
    32: "inUse", // ERROR_SHARING_VIOLATION
    33: "inUse", // ERROR_LOCK_VIOLATION
    39: "diskFull",
    50: "unsupportedOp", // ERROR_NOT_SUPPORTED
    53: "network",
    64: "network",
    67: "network",
    80: "exists",
    112: "diskFull",
    123: "invalidName", // ERROR_INVALID_NAME
    145: "notEmpty", // ERROR_DIR_NOT_EMPTY
    183: "exists",
    206: "nameTooLong", // ERROR_FILENAME_EXCED_RANGE
    225: "virus", // ERROR_VIRUS_INFECTED
    362: "cloudFile", // ERROR_CLOUD_FILE_PROVIDER_NOT_RUNNING (OneDrive 등)
    1231: "network",
    1314: "linkPrivilege", // ERROR_PRIVILEGE_NOT_HELD
    1326: "networkLogon", // ERROR_LOGON_FAILURE (네트워크 공유 로그인)
    10051: "connUnreachable", // WSAENETUNREACH
    10054: "connReset", // WSAECONNRESET
    10060: "connTimeout", // WSAETIMEDOUT
    10061: "connRefused", // WSAECONNREFUSED
    10065: "connUnreachable", // WSAEHOSTUNREACH
  },
  unix: UNIX_CODES,
  macos: {
    ...UNIX_CODES,
    45: "unsupportedOp", // ENOTSUP
    51: "connUnreachable", // ENETUNREACH
    54: "connReset", // ECONNRESET
    60: "connTimeout", // ETIMEDOUT
    61: "connRefused", // ECONNREFUSED
    62: "linkLoop", // ELOOP
    63: "nameTooLong", // ENAMETOOLONG
    65: "connUnreachable", // EHOSTUNREACH
    66: "notEmpty", // ENOTEMPTY
    69: "diskFull", // EDQUOT
  },
  linux: {
    ...UNIX_CODES,
    36: "nameTooLong", // ENAMETOOLONG
    39: "notEmpty", // ENOTEMPTY
    40: "linkLoop", // ELOOP
    95: "unsupportedOp", // EOPNOTSUPP
    101: "connUnreachable", // ENETUNREACH
    104: "connReset", // ECONNRESET
    110: "connTimeout", // ETIMEDOUT
    111: "connRefused", // ECONNREFUSED
    113: "connUnreachable", // EHOSTUNREACH
    122: "diskFull", // EDQUOT
  },
};

/** 메시지 패턴 → 원인. 위에서부터 먼저 맞는 것. 원격(SSH) 오류는 번호가 없어 이 표로 간다. */
const PATTERNS: Array<[RegExp, Reason]> = [
  [/through a link|path-traversal|zip-slip/i, "unsafeArchive"],
  [/remote extract supports only/i, "remoteFormat"],
  [
    /compression method not supported|unsupported zip archive|unsupported compression/i,
    "zipMethod",
  ],
  [
    /archive is damaged|corrupt deflate|invalid gzip header|invalid checksum|unexpected end of file|failed to fill whole buffer|invalid zip archive|could not find central directory|bad header|not a tar/i,
    "damagedArchive",
  ],
  [/invalid entry name|invalid name|syntax is incorrect/i, "invalidName"],
  [/name too long/i, "nameTooLong"],
  [/too many levels of symbolic links/i, "linkLoop"],
  [/directory not empty/i, "notEmpty"],
  [
    // unzip exit 50 = 해제 중 디스크 가득 ("write error (disk full?)").
    /no space left|disk is full|disk full|quota exceeded|host command failed \(exit 50\)/i,
    "diskFull",
  ],
  [/being used by another process|resource busy|text file busy/i, "inUse"],
  [/read-only file system|write.protected/i, "readOnly"],
  [
    /permission denied|access is denied|operation not permitted/i,
    "accessDenied",
  ],
  [/no such file|cannot find the (file|path)/i, "notFound"],
  [/already exists/i, "exists"],
  [/device is not ready/i, "deviceNotReady"],
  [/contains a virus/i, "virus"],
  [/cloud file provider|cloud operation/i, "cloudFile"],
  [/operation not supported/i, "unsupportedOp"],
];

/** 압축·동기화 작업의 구체적 문구 — 아래 `PATTERNS` 앞부분(압축·안전)보다도 먼저 본다. */
const ARCHIVE_PATTERNS: Array<[RegExp, Reason]> = [
  // 서버 unzip exit 81 — AES 암호 zip 등. 암호를 다시 물어도 소용없어 내 PC 로 복사해 풀어야 한다.
  [/remote host's unzip cannot extract/i, "remoteZipUnsupported"],
  [/unsafe path in/i, "unsafeArchive"], // rar 의 경로 탈출 항목
  [/large file option has not been set/i, "zipLargeFile"], // zip 4GB 초과
  [/nothing to repack/i, "repackEmpty"],
  // 동기화는 local↔local·같은 서버만 — 그 밖의 조합은 비교 창의 적용/병합으로 안내.
  [/sync supports local↔local/i, "syncCrossHost"],
];

/** 서버 호스트 프로그램이 없다는 원문 → 프로그램 이름 (unzip 미설치, tar 의 압축 코덱 없음). */
const MISSING_PROGRAM: RegExp[] = [
  /`([\w.+-]+)` is not installed on the remote host/i,
  /([\w.+-]+): Cannot exec\b/i, // GNU tar: "tar (child): xz: Cannot exec: No such file…"
  /unable to run program "([\w.+-]+)/i, // bsdtar
  /unrecognized option '--(zstd)'/i, // zstd 를 모르는 오래된 GNU tar
];

/** 호스트 명령 실패의 개발자용 앞머리 (`core/archive.rs` `host_failure`). */
const HOST_FAILURE = /^host command failed \(exit (\d+)\):\s*/i;

/**
 * 연결 원인 문구 — 번호보다 먼저 본다. 연결 오류의 번호는 원격·중계 쪽 것일 수 있어
 * 이 PC 의 표와 다를 수 있다(문구가 더 믿을 만하다).
 */
const CONNECTION_PATTERNS: Array<[RegExp, Reason]> = [
  [/connection refused|actively refused/i, "connRefused"],
  [/timed out|did not properly respond/i, "connTimeout"],
  [
    /no route to host|network is unreachable|unreachable (host|network)/i,
    "connUnreachable",
  ],
  [
    /failed to lookup address|nodename nor servname|name or service not known|no such host is known|temporary failure in name resolution/i,
    "connDns",
  ],
  [/connection reset|broken pipe|forcibly closed/i, "connReset"],
];

/** kind 만으로 원인이 정해지는 것. */
const KIND_REASON: Partial<Record<string, Reason>> = {
  NeedPassword: "needPassword",
  AuthFailed: "authFailed",
  Cancelled: "cancelled",
  CrossDevice: "crossDevice",
  HostKeyUnverified: "hostKey",
  NotPermitted: "notPermitted",
};

/**
 * kind 가 원인을 이미 말하는 경우, 패턴·번호가 고른 원인이 그와 어울려야 한다 — 아니면
 * 원문 속 다른 단어(파일 이름 등)를 잘못 읽은 것이니 kind 를 믿는다.
 */
const KIND_COMPATIBLE: Partial<Record<string, ReadonlySet<Reason>>> = {
  PermissionDenied: new Set<Reason>([
    "accessDenied",
    "readOnly",
    "inUse",
    "linkPrivilege",
    "virus",
    "cloudFile",
    "networkLogon",
  ]),
  NotFound: new Set<Reason>([
    "notFound",
    "deviceNotReady",
    "network",
    "cloudFile",
  ]),
};

/** 번호·패턴으로 못 고르면 kind 로 (위 두 표가 더 구체적이라 나중에 본다). */
const KIND_FALLBACK: Partial<Record<string, Reason>> = {
  PermissionDenied: "accessDenied",
  NotFound: "notFound",
  ConnectionFailed: "connection",
};

function hostOs(): HostOs {
  try {
    const p = platform();
    return p === "windows" || p === "macos" || p === "linux" ? p : "unix";
  } catch {
    return "unix"; // 테스트·웹 미리보기 — Tauri OS 플러그인 없음
  }
}

/** Rust io::Error Display 의 "(os error N)" 꼬리표/접두 제거. */
function cleanMessage(m: string): string {
  return m
    .replace(/\s*\(os error \d+\)/gi, "")
    .replace(/^os error \d+:\s*/i, "")
    .trim();
}

function osCode(m: string): number | undefined {
  const all = [...m.matchAll(/os error (\d+)/gi)];
  // 가장 안쪽(마지막) 원인이 실제 OS 오류.
  const last = all.at(-1)?.[1];
  return last === undefined ? undefined : Number(last);
}

/**
 * 원문 속 경로 하나 (`start`~`end` 는 원문 위치).
 * `backup` = "original preserved at backup <경로>" 의 백업 위치 — 실패한 대상이 아니다.
 */
interface PathHit {
  path: string;
  start: number;
  end: number;
  backup: boolean;
}

/** 절대 경로의 시작: `/x`·`~/x`·`C:\`·`\\server`. */
const ABS_START = String.raw`(?:~?\/(?=[^\s/])|[A-Za-z]:[\\/]|\\\\(?=[^\s\\]))`;
/**
 * 따옴표 없는 절대 경로 — 앞은 줄 시작·공백·여는 괄호·따옴표, 끝은 `: `·`; `·` (`·
 * 따옴표·닫는 괄호·줄 끝. 파일 이름의 공백은 허용한다("분기보고서 2026.xlsx").
 */
const BARE_PATH = new RegExp(
  String.raw`(?<=^|[\s(\`'"“‘])${ABS_START}[^\n]*?(?=: |; | \(|[\`'"”’]|\)(?:$|[\s:;,.])|\n|$)`,
  "g",
);
/** 따옴표·백틱으로 감싼 덩어리. */
const QUOTED = /[`'"“‘]([^`'"“”‘’\n]+)[`'"”’]/g;
const ABS_ONLY = new RegExp(`^${ABS_START}`);

/**
 * 따옴표 안의 덩어리가 경로처럼 보이는지 — 절대 경로이거나, 공백 없는 `a/b` 꼴.
 * 상대 꼴에서 URL(`scheme://`)·`:` 가 든 주소(IPv6/CIDR `…::/64`)·비율(`3/4`)은 뺀다.
 */
function looksLikePath(s: string): boolean {
  if (ABS_ONLY.test(s)) return true;
  return (
    /[\\/]/.test(s) &&
    !/\s/.test(s) &&
    !s.startsWith("-") &&
    !s.includes(":") &&
    !/^\d+\/\d+$/.test(s)
  );
}

/** 롤백 실패 문장의 백업 위치 표지 (`core/ops.rs` copy/move — 형식 고정). */
const BACKUP_MARKER = "original preserved at backup ";
const ROLLBACK_SUFFIX = " (rollback failed:";

/**
 * 백업 위치 — 표지와 **마지막** ` (rollback failed:` 사이 전체. 백업 이름은 원래 이름에
 * `.bak.<시각>` 을 붙인 것이라 괄호·작은따옴표 같은 정상 이름 문자를 그대로 가진다 —
 * 일반 경로 파서의 경계(` (`·따옴표)로 자르면 안 된다.
 */
function findBackup(raw: string): PathHit | undefined {
  const at = raw.indexOf(BACKUP_MARKER);
  if (at < 0) return undefined;
  const start = at + BACKUP_MARKER.length;
  const suffix = raw.lastIndexOf(ROLLBACK_SUFFIX);
  const end = suffix > start ? suffix : raw.length;
  const path = raw.slice(start, end).trimEnd();
  return path
    ? { path, start, end: start + path.length, backup: true }
    : undefined;
}

/** 백엔드 `DuetError` Display 앞머리 (`types/error.rs`) — 항목 이름의 끝을 찾는 데 쓴다. */
const ERROR_PREFIX =
  "(?:not found|permission denied|connection failed|auth failed|destructive op not permitted|cancelled|not supported|password required|io|cross-device|ssh|unverified host key)\\b";
/**
 * 여러 항목 실패 요약(`core/ops.rs` combine_failures: `N item(s) failed — <name>: <err>; …`)
 * 의 항목 이름. 이름에 `: ` 가 있을 수 있어 뒤따르는 오류 앞머리까지를 이름으로 본다.
 */
const ITEM_NAME = new RegExp(
  `(?:— |; )(?!${BACKUP_MARKER})(.+?): (?=${ERROR_PREFIX})`,
  "g",
);

function findItemNames(raw: string): PathHit[] {
  if (!/^\d+ item\(s\) failed — /.test(raw)) return [];
  return [...raw.matchAll(ITEM_NAME)].map((m) => {
    const path = m[1]!;
    const start = m.index + m[0].indexOf(path);
    return { path, start, end: start + path.length, backup: false };
  });
}

/** 원문에서 경로를 찾는다(겹치지 않게, 앞에서부터). */
function findPaths(raw: string, kind: string | undefined): PathHit[] {
  const hit = (path: string, start: number): PathHit => ({
    path,
    start,
    end: start + path.length,
    backup: false,
  });
  // 원격 SFTP 의 NotFound/PermissionDenied 는 message 가 경로 그 자체다(`fs/ssh.rs` map_sftp_error).
  // 괄호·`: `·줄바꿈이 든 이름("report (1).txt", "a: b.txt")도 통째로.
  // 로컬 io 오류("(os error N)" 꼬리표)는 경로로 시작해도 이 모양이 아니다.
  const whole = raw.trim();
  if (
    (kind === "NotFound" || kind === "PermissionDenied") &&
    ABS_ONLY.test(whole) &&
    !/\(os error \d+\)/i.test(whole)
  )
    return [hit(whole, raw.indexOf(whole))];
  const hits: PathHit[] = [];
  const backup = findBackup(raw);
  if (backup) hits.push(backup);
  const free = (start: number, end: number) =>
    !hits.some((h) => start < h.end && h.start < end);
  for (const item of findItemNames(raw))
    if (free(item.start, item.end)) hits.push(item);
  for (const m of raw.matchAll(QUOTED)) {
    const inner = m[1]!.trim();
    const start = m.index + m[0].indexOf(inner);
    if (looksLikePath(inner) && free(m.index, m.index + m[0].length))
      hits.push(hit(inner, start));
  }
  for (const m of raw.matchAll(BARE_PATH)) {
    const path = m[0].replace(/[.,]$/, "");
    const start = m.index;
    if (free(start, start + path.length)) hits.push(hit(path, start));
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** 경로 자리를 지운 원문 — 패턴·번호가 파일 이름을 원인으로 읽지 않게. */
function maskPaths(raw: string, hits: PathHit[]): string {
  let out = "";
  let at = 0;
  for (const h of hits) {
    out += `${raw.slice(at, h.start)}…`;
    at = h.end;
  }
  return out + raw.slice(at);
}

/** 문장에 붙일 대상 이름 — 백업 위치는 대상이 아니다. */
function targetName(hits: PathHit[]): string | undefined {
  const target = hits.find((h) => !h.backup);
  if (!target) return undefined;
  const name = basename(target.path, "");
  return name && name !== "~" && name !== "." && name !== ".."
    ? name
    : undefined;
}

/**
 * 원인 문장에 대상 이름(앞)과 백업 위치(뒤)를 붙인다 — 이미 들어 있으면 그대로.
 * 백업 위치는 롤백 실패 시 원본이 남은 곳이라 전체 경로가 필요하다.
 */
function withTarget(text: string, paths: PathHit[]): string {
  let out = text;
  const name = targetName(paths);
  if (name && !out.includes(name))
    out = i18n.t("errors.withName", { name, text: out });
  const backup = paths.find((h) => h.backup)?.path;
  if (backup && !out.includes(backup))
    out = `${out} ${i18n.t("errors.backupKept", { path: backup })}`;
  return out;
}

function pickReason(
  kind: string | undefined,
  message: string,
  os: HostOs,
): { reason: Reason; vars?: Record<string, string> } | undefined {
  const fixed = kind ? KIND_REASON[kind] : undefined;
  if (fixed) return { reason: fixed };
  for (const re of MISSING_PROGRAM) {
    const prog = re.exec(message)?.[1];
    if (prog) return { reason: "remoteMissingProgram", vars: { prog } };
  }
  // 압축·안전 관련 문구는 번호보다 구체적이다(손상된 gzip 도 io 오류 번호가 없다).
  for (const [re, reason] of ARCHIVE_PATTERNS)
    if (re.test(message)) return { reason };
  for (const [re, reason] of PATTERNS.slice(0, 4))
    if (re.test(message)) return { reason };
  for (const [re, reason] of CONNECTION_PATTERNS)
    if (re.test(message)) return { reason };
  // 원격 명령(Ssh)의 "(os error N)" 은 서버 OS 의 번호 — 이 PC 표로 읽지 않는다.
  const code = kind === "Ssh" ? undefined : osCode(message);
  const byCode = code === undefined ? undefined : OS_CODES[os][code];
  if (byCode) return { reason: byCode };
  for (const [re, reason] of PATTERNS.slice(4))
    if (re.test(message)) return { reason };
  // 호스트 명령이 출력 없이 실패 — 종료 코드만 알린다.
  const exit = HOST_FAILURE.exec(message.trim());
  if (exit && !message.trim().slice(exit[0].length))
    return { reason: "remoteExit", vars: { code: exit[1] ?? "" } };
  return kindFallback(kind);
}

function kindFallback(
  kind: string | undefined,
): { reason: Reason; vars?: Record<string, string> } | undefined {
  const fallback = kind ? KIND_FALLBACK[kind] : undefined;
  return fallback ? { reason: fallback } : undefined;
}

/** 오류를 쉬운 한 문장 + 원문으로. `os` 는 테스트용(기본: 이 PC). */
export function explainError(
  e: unknown,
  os: HostOs = hostOs(),
): ExplainedError {
  let kind: string | undefined;
  let raw = "";
  if (typeof e === "object" && e !== null) {
    const o = e as Partial<DuetError> & { message?: unknown };
    kind = typeof o.kind === "string" ? o.kind : undefined;
    raw = typeof o.message === "string" ? o.message : "";
  } else {
    raw = String(e);
  }
  const detail = raw.trim();
  const cleaned = cleanMessage(raw);
  const paths = findPaths(raw, kind);
  const target = targetName(paths);
  const done = (text: string): ExplainedError =>
    target ? { text, detail, target } : { text, detail };
  const masked = maskPaths(raw, paths);
  // 롤백 실패("…; original preserved at backup … (rollback failed: …)")는 앞쪽이 원래 원인.
  const cut = masked.search(/;?\s*original preserved at backup/i);
  let picked =
    (cut > 0 ? pickReason(kind, masked.slice(0, cut), os) : undefined) ??
    pickReason(kind, masked, os);
  const compatible = kind ? KIND_COMPATIBLE[kind] : undefined;
  if (picked && compatible && !compatible.has(picked.reason))
    picked = kindFallback(kind);
  if (picked) {
    const text = i18n.t(`errors.reason.${picked.reason}`, picked.vars ?? {});
    if (!APPEND_DETAIL.has(picked.reason) || !cleaned)
      return done(withTarget(text, paths));
    // 이미 설명한 오류를 다시 감싼 경우(대화상자가 formatErr 결과를 message 로 넘김) 그대로.
    if (cleaned.startsWith(text)) return done(cleaned);
    return done(`${text} — ${cleaned}`);
  }
  // 원인을 모르면 종류 라벨 + 원문 — 정보를 숨기지 않는다.
  const label = kind
    ? i18n.t(`errors.kind.${kind}`, { defaultValue: kind })
    : undefined;
  // 호스트 명령 실패의 개발자용 앞머리는 빼고 서버가 남긴 말만.
  const shown = cleaned.replace(HOST_FAILURE, "");
  if (label && shown) {
    const text = shown.toLowerCase().startsWith(label.toLowerCase())
      ? shown
      : `${label} — ${shown}`;
    return done(text);
  }
  return done(label ?? (shown || String(e)));
}

/**
 * 오류를 한 줄로 — 호출부는 앞에 동작을 붙인다 ("복사 실패: …").
 * 쉬운 문장만 돌려준다. 원문이 필요하면 `explainError`.
 */
export function formatErr(e: unknown): string {
  return explainError(e).text;
}
