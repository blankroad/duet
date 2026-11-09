/**
 * sync-compare 점검(opus-1, C-26) — 비교·동기화·머지·검색 오류가 사용자에게 어떤 문장으로
 * 보이는지. 백엔드 원문은 core/ops.rs·commands 의 실제 문자열을 그대로 옮겼다.
 * `it.fails` = 기대(쉬운 한국어 문장)와 다른 현재 동작을 재현.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { explainError } from "@/lib/error";

// 백엔드 원문 (파일:라인)
const SYNC_RELAY_REFUSED = {
  // core/ops.rs:1123 sync_plan — 로컬↔원격(relay) 조합에서 동기화를 누르면.
  kind: "NotSupported",
  message:
    "sync supports local↔local and same-host SSH only (cross-host relay is a follow-up)",
} as const;
const MERGE_TRUNCATED = {
  // core/ops.rs:1799 merge_bidir
  kind: "Io",
  message:
    "merge refused: comparison was truncated (too many entries) — narrow the scope",
} as const;
const THREE_WAY_NOT_DIR = {
  // core/three_way.rs:135 — base 입력이 파일이거나 오타면(없으면 NotFound 가 먼저 남)
  kind: "Io",
  message: "three-way: all sides must be directories",
} as const;
const COMPARE_NOT_DIR = {
  // core/compare.rs:201 — 한쪽 패널이 아카이브 안/특수 위치 등
  kind: "Io",
  message: "compare: both sides must be directories",
} as const;
const SYNC_SAME_DIR = {
  // core/ops.rs:1109
  kind: "Io",
  message: "sync: source and destination are the same",
} as const;

describe("sync-compare C-26: 이 영역 오류의 사용자 문장 (ko)", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("ko");
  });
  afterAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("현재 문장 기록 — 종류 라벨 + 영문 원문이 그대로 붙는다 (relay 동기화는 SC-15 로 쉬운 문장)", () => {
    const out = [
      SYNC_RELAY_REFUSED,
      MERGE_TRUNCATED,
      THREE_WAY_NOT_DIR,
      COMPARE_NOT_DIR,
      SYNC_SAME_DIR,
    ].map((e) => explainError(e, "unix").text);
    expect(out).toEqual([
      i18n.t("errors.reason.syncCrossHost"),
      "입출력 오류 — merge refused: comparison was truncated (too many entries) — narrow the scope",
      "입출력 오류 — three-way: all sides must be directories",
      "입출력 오류 — compare: both sides must be directories",
      "입출력 오류 — sync: source and destination are the same",
    ]);
  });

  it(
    "sync-compare: relay 동기화 거부가 한국어로 '왜 안 되는지·대안'을 말해야 한다",
    () => {
      const t = explainError(SYNC_RELAY_REFUSED, "unix").text;
      expect(t).not.toMatch(/sync supports|follow-up/);
    },
  );

  it.fails(
    "sync-compare: '병합 거부(비교 잘림)'는 입출력 오류가 아니라 범위를 좁히라는 안내여야 한다",
    () => {
      const t = explainError(MERGE_TRUNCATED, "unix").text;
      expect(t.startsWith("입출력 오류")).toBe(false);
    },
  );

  it("압축 경로의 '`rsync` 미설치' 문구는 쉬운 문장으로 바뀐다(대조군)", () => {
    const t = explainError(
      {
        kind: "NotSupported",
        message: "`rsync` is not installed on the remote host",
      },
      "unix",
    ).text;
    expect(t).toMatch(/rsync/);
    expect(t).not.toMatch(/is not installed on the remote host/);
  });

  it.fails(
    "sync-compare: 같은 호스트 동기화의 rsync 없음(ops.rs:1412)도 같은 쉬운 문장이어야 한다",
    () => {
      const t = explainError(
        {
          kind: "NotSupported",
          message: "same-host sync requires rsync on the host",
        },
        "unix",
      ).text;
      // 현재: "지원하지 않음 — same-host sync requires rsync on the host"
      expect(t).not.toMatch(/same-host sync requires/);
    },
  );
});
