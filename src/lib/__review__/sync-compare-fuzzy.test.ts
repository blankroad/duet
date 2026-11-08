/**
 * sync-compare 점검 (C-25) — fuzzy.ts 한글 매칭 재현 테스트.
 * 결함 재현은 `it.fails` (기대 동작을 단언 → 현재 실패).
 */
import { describe, expect, it } from "vitest";
import { fuzzyScore } from "@/lib/fuzzy";

describe("sync-compare C-25 fuzzyScore 한글", () => {
  it("NFC 질의 ↔ NFC 텍스트: 음절 부분열 매칭은 된다", () => {
    expect(fuzzyScore("문서", "Bookmark: 내 문서")).not.toBeNull();
    expect(fuzzyScore("내문", "Bookmark: 내 문서")).not.toBeNull();
  });

  it.fails(
    "sync-compare: NFD(macOS 파일명) 텍스트는 NFC 로 입력한 질의와 매칭 안 됨",
    () => {
      const nfdLabel = "Bookmark: 문서".normalize("NFD");
      expect(fuzzyScore("문서", nfdLabel)).not.toBeNull();
    },
  );

  it.fails("sync-compare: 초성 검색('ㅁㅅ' → '문서') 미지원", () => {
    expect(fuzzyScore("ㅁㅅ", "Bookmark: 문서")).not.toBeNull();
  });
});
