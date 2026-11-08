/**
 * archive 점검 (opus, C-15) — 해제 알림(describeArchiveNotice) 문장·자세히 목록.
 * 백엔드는 이름을 앞쪽 20개까지만 싣고 개수는 전체를 보낸다(services/archive_events.rs SAMPLE).
 */
import { afterAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { describeArchiveNotice } from "@/hooks/useArchiveNoticeEvents";
import type { ArchiveNoticeEvent } from "@/types/bindings";

afterAll(async () => {
  await i18n.changeLanguage("en");
});

const names = (n: number, p: string) =>
  Array.from({ length: n }, (_, i) => `${p}${i}`);

describe("archive-opus C-15: describeArchiveNotice", () => {
  it("ko: 링크 50개(이름 20개만 전달) + 이름 바꿈 1개", async () => {
    await i18n.changeLanguage("ko");
    const ev: ArchiveNoticeEvent = {
      archive_name: "프로젝트.tar.gz",
      skipped_links: names(20, "node_modules/.bin/l"),
      skipped_links_count: 50,
      renamed: ["docs/a:b.txt"],
      renamed_count: 1,
    };
    const { message, detail } = describeArchiveNotice(ev);
    expect(message).toContain("프로젝트.tar.gz");
    expect(message).toContain("링크 50개");
    expect(message).toContain("이름 1개");
    const lines = detail.split("\n");
    expect(lines[0]).toBe("건너뛴 링크:");
    expect(lines.filter((l) => l.startsWith("  node_modules"))).toHaveLength(20);
    expect(detail).toContain("… 외 30개");
    expect(detail).toContain("이름을 바꾼 항목 (원래 이름):");
    expect(detail).toContain("  docs/a:b.txt");
    // 이름이 1개뿐이면 "외 N개" 줄이 없어야.
    expect(detail.match(/외 \d+개/g)).toHaveLength(1);
  });

  it("en: 단수/복수", async () => {
    await i18n.changeLanguage("en");
    const one = describeArchiveNotice({
      archive_name: "a.tar",
      skipped_links: ["x"],
      skipped_links_count: 1,
      renamed: [],
      renamed_count: 0,
    });
    expect(one.message).toMatch(/1 link couldn't be created/);
    expect(one.detail).not.toMatch(/more/);
    const many = describeArchiveNotice({
      archive_name: "a.tar",
      skipped_links: [],
      skipped_links_count: 0,
      renamed: names(20, "n"),
      renamed_count: 21,
    });
    expect(many.message).toMatch(/21 names had characters/);
    expect(many.detail).toMatch(/… and 1 more/);
  });

  it.fails("archive-26: 바뀐 이름은 '원래 이름' 만 보여 준다 — 풀린 폴더에서 찾을 새 이름(_ 치환)이 없음 (기대: 새 이름도 표시)", async () => {
    await i18n.changeLanguage("ko");
    const { detail } = describeArchiveNotice({
      archive_name: "a.tar",
      skipped_links: [],
      skipped_links_count: 0,
      renamed: ["docs/a:b.txt"],
      renamed_count: 1,
    });
    expect(detail).toContain("a_b.txt");
  });
});
