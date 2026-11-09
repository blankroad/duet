/**
 * sync-compare 점검 (C-09) — 비교 인라인 diff 미리보기 재현 테스트.
 * 결함 재현은 `it.fails` (기대 동작을 단언 → 현재 실패).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  CompareEntry,
  ComparePairPreview,
  Location,
  PreviewData,
} from "@/types/bindings";
import { commands } from "@/types/bindings";
import i18n from "@/i18n";
import { CompareDiffPreview } from "../CompareDiffPreview";
import { lineDiff } from "@/lib/lineDiff";

vi.mock("@/types/bindings", () => ({
  commands: {
    fsComparePairPreview: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.mocked(commands.fsComparePairPreview).mockReset();
});

const L: Location = { source: { kind: "local" }, path: "/fixture/l" };
const R: Location = { source: { kind: "local" }, path: "/fixture/r" };

const entry = (status: CompareEntry["status"]): CompareEntry => ({
  rel: "a.txt",
  kind: "file",
  status,
  left_size: 1,
  right_size: 1,
  left_mtime_ms: 1,
  right_mtime_ms: 1,
});

const text = (s: string, truncated = false): PreviewData => ({
  kind: "text",
  text: s,
  bytes_base64: null,
  mime: null,
  truncated,
  total_size: s.length,
});

const other = (kind: PreviewData["kind"]): PreviewData => ({
  kind,
  text: null,
  bytes_base64: null,
  mime: null,
  truncated: false,
  total_size: 10_000_000,
});

function mockPair(p: ComparePairPreview) {
  vi.mocked(commands.fsComparePairPreview).mockResolvedValue({
    status: "ok",
    data: p,
  });
}

const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`) =>
  Array.from({ length: n }, (_, i) => f(i)).join("\n");

/** 렌더된 diff 행 중 +/- 마커가 붙은 행 수. */
function changedRows(container: HTMLElement): number {
  return Array.from(container.querySelectorAll(".font-mono > div")).filter(
    (d) => {
      const mark = d.querySelector("span")?.textContent;
      return mark === "+" || mark === "-";
    },
  ).length;
}

describe("sync-compare C-09 CompareDiffPreview", () => {
  it("한쪽에만 있는 파일은 백엔드 호출 없이 '미리보기 없음' 안내", () => {
    render(
      <CompareDiffPreview entry={entry("left_only")} left={L} right={R} />,
    );
    expect(screen.getByText(i18n.t("dialog.compare.previewNone"))).toBeTruthy();
    expect(commands.fsComparePairPreview).not.toHaveBeenCalled();
  });

  it("왼쪽이 600줄 초과면 잘림 안내가 표시된다 (정상 경로)", async () => {
    mockPair({ left: text(lines(700)), right: text(lines(10)) });
    render(<CompareDiffPreview entry={entry("differ")} left={L} right={R} />);
    await waitFor(() =>
      expect(
        screen.getByText(i18n.t("dialog.compare.previewTruncated")),
      ).toBeTruthy(),
    );
  });

  it.fails(
    "sync-compare: 오른쪽만 600줄 초과면 잘림 안내가 안 뜬다 (왼쪽 줄 수만 검사)",
    async () => {
      mockPair({ left: text(lines(10)), right: text(lines(700)) });
      render(<CompareDiffPreview entry={entry("differ")} left={L} right={R} />);
      await waitFor(() =>
        expect(document.querySelector(".font-mono")).toBeTruthy(),
      );
      // 기대: 오른쪽 100줄이 잘렸으므로 잘림 안내가 보여야 한다.
      expect(
        screen.getByText(i18n.t("dialog.compare.previewTruncated")),
      ).toBeTruthy();
    },
  );

  it.fails(
    "sync-compare: 차이가 600줄 이후에만 있으면 'differ' 행인데 +/- 줄이 하나도 안 보인다",
    async () => {
      const base = lines(800);
      const changed = lines(800, (i) => (i === 700 ? "CHANGED" : `line ${i}`));
      mockPair({ left: text(base), right: text(changed) });
      const { container } = render(
        <CompareDiffPreview entry={entry("differ")} left={L} right={R} />,
      );
      await waitFor(() =>
        expect(container.querySelector(".font-mono")).toBeTruthy(),
      );
      // 기대: 실제로 다른 줄(700)이 보이거나 최소 1개의 변경 행이 보여야 한다.
      expect(changedRows(container)).toBeGreaterThan(0);
    },
  );

  it("SC-22: CRLF vs LF 만 다른 파일은 내용 줄이 같게 보이고 줄끝 차이를 따로 알린다", async () => {
    mockPair({
      left: text("alpha\r\nbeta\r\ngamma\r\n"),
      right: text("alpha\nbeta\ngamma\n"),
    });
    const { container } = render(
      <CompareDiffPreview entry={entry("differ")} left={L} right={R} />,
    );
    await waitFor(() =>
      expect(container.querySelector(".font-mono")).toBeTruthy(),
    );
    // 현재: 3줄 모두 del+add (눈으로는 똑같은 텍스트 6행).
    // 기대: 줄끝(CRLF/LF) 차이라는 안내가 있거나, 내용 줄은 같게 취급.
    const hint = /CRLF|LF|줄 ?끝|line ending/i.test(
      container.textContent ?? "",
    );
    expect(hint).toBe(true);
    expect(changedRows(container)).toBe(0);
  });

  it.fails(
    "sync-compare: 큰 이미지 쌍은 내부 enum 'toolarge ↔ toolarge (텍스트/이미지 아님)' 이 그대로 보인다",
    async () => {
      mockPair({ left: other("toolarge"), right: other("toolarge") });
      const { container } = render(
        <CompareDiffPreview entry={entry("differ")} left={L} right={R} />,
      );
      await waitFor(() => expect(container.textContent).toMatch(/↔/));
      // 기대: 내부 식별자 대신 사람이 읽는 문구 (예: "너무 커서 미리보기 생략").
      expect(container.textContent).not.toMatch(/toolarge/);
    },
  );

  it("바이너리 쌍은 'binary ↔ binary' 안내 (현재 동작 기록)", async () => {
    mockPair({ left: other("binary"), right: other("binary") });
    const { container } = render(
      <CompareDiffPreview entry={entry("differ")} left={L} right={R} />,
    );
    await waitFor(() =>
      expect(container.textContent).toMatch(/binary ↔ binary/),
    );
  });

  it("lineDiff: 600×600 전부 다른 줄(최악)도 1초 안에 끝난다 — 600줄 cap 덕에 폭주 없음", () => {
    const a = Array.from({ length: 600 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 600 }, (_, i) => `b${i}`);
    const t0 = performance.now();
    const ops = lineDiff(a, b);
    const ms = performance.now() - t0;
    expect(ops).toHaveLength(1200);
    expect(ms).toBeLessThan(1000);
  });
});
