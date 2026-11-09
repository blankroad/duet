import { platform } from "@tauri-apps/plugin-os";
import i18n from "@/i18n";
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
    63: "nameTooLong", // ENAMETOOLONG
    65: "connUnreachable", // EHOSTUNREACH
    66: "notEmpty", // ENOTEMPTY
    69: "diskFull", // EDQUOT
  },
  linux: {
    ...UNIX_CODES,
    36: "nameTooLong", // ENAMETOOLONG
    39: "notEmpty", // ENOTEMPTY
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
  [/invalid entry name|syntax is incorrect/i, "invalidName"],
  [/name too long/i, "nameTooLong"],
  [/directory not empty/i, "notEmpty"],
  [/no space left|disk is full|quota exceeded/i, "diskFull"],
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

function pickReason(
  kind: string | undefined,
  message: string,
  os: HostOs,
): { reason: Reason; prog?: string } | undefined {
  const fixed = kind ? KIND_REASON[kind] : undefined;
  if (fixed) return { reason: fixed };
  const prog = /`([\w.+-]+)` is not installed on the remote host/i.exec(
    message,
  )?.[1];
  if (prog) return { reason: "remoteMissingProgram", prog };
  // 압축·안전 관련 문구는 번호보다 구체적이다(손상된 gzip 도 io 오류 번호가 없다).
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
  const picked = pickReason(kind, raw, os);
  if (picked) {
    const text = i18n.t(`errors.reason.${picked.reason}`, {
      prog: picked.prog,
    });
    if (!APPEND_DETAIL.has(picked.reason) || !cleaned) return { text, detail };
    // 이미 설명한 오류를 다시 감싼 경우(대화상자가 formatErr 결과를 message 로 넘김) 그대로.
    if (cleaned.startsWith(text)) return { text: cleaned, detail };
    return { text: `${text} — ${cleaned}`, detail };
  }
  // 원인을 모르면 종류 라벨 + 원문 — 정보를 숨기지 않는다.
  const label = kind
    ? i18n.t(`errors.kind.${kind}`, { defaultValue: kind })
    : undefined;
  if (label && cleaned) {
    const text = cleaned.toLowerCase().startsWith(label.toLowerCase())
      ? cleaned
      : `${label} — ${cleaned}`;
    return { text, detail };
  }
  return { text: label ?? (cleaned || String(e)), detail };
}

/**
 * 오류를 한 줄로 — 호출부는 앞에 동작을 붙인다 ("복사 실패: …").
 * 쉬운 문장만 돌려준다. 원문이 필요하면 `explainError`.
 */
export function formatErr(e: unknown): string {
  return explainError(e).text;
}
