// fileops 점검 R2(2026-11-08, opus) — 백엔드 실제 오류 문자열이 사용자 토스트에서 어떻게
// 보이는지. 토스트 본문은 `explainError(e).text`(= formatErr), 원문은 알림 "자세히"(detail).
// 문자열은 각 재현 테스트의 실제 출력(macOS)과, 같은 코드 경로의 Windows 모양.
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { explainError } from "@/lib/error";

beforeAll(async () => {
  await i18n.changeLanguage("ko");
});

const io = (message: string) => ({ kind: "Io", message });

describe("fileops-09 폴더 Replace 롤백 실패 — 백업 위치가 토스트에 보이나", () => {
  // c04_partial_folder_failure_restores_old_folder 의 오류 모양 (ops.rs copy relay 롤백 실패).
  // 단일 항목 실패도 combine_failures 로 "1 item(s) failed — <name>: <e>" 로 감싸진다.
  const mac = io(
    "1 item(s) failed — a: io: copy failed (permission denied: injected list failure); " +
      "original preserved at backup /w/dst/a.bak.20261108-101500 " +
      "(rollback failed: io: Directory not empty (os error 66))",
  );
  // Windows: 하위 폴더 읽기 거부(os error 5) 후, 부분 사본이 있는 폴더 위로 rename → 거부(os error 5).
  const win = io(
    "1 item(s) failed — a: io: copy failed (permission denied: Access is denied. (os error 5)); " +
      "original preserved at backup C:\\w\\dst\\a.bak.20261108-101500 " +
      "(rollback failed: permission denied: Access is denied. (os error 5))",
  );

  it.fails("fileops-09: macOS: 토스트 본문에 백업 경로가 있다", () => {
    const r = explainError(mac, "unix");
    expect(r.detail).toContain("a.bak.");
    expect(r.text, r.text).toContain("a.bak.");
  });

  it.fails("fileops-09: Windows: 토스트 본문에 백업 경로가 있다", () => {
    const r = explainError(win, "windows");
    expect(r.detail).toContain("a.bak.");
    expect(r.text, r.text).toContain("a.bak.");
  });
});

describe("fileops-04 자기 하위로 복사·이동 — 원인 안내", () => {
  it.fails("fileops-04: 복사(경로 한계까지 자기 복제) 오류가 '더 짧은 위치에서 다시' 로 안내되지 않는다", () => {
    // c02_reject_copy_into_child 실제 출력(macOS).
    const r = explainError(
      io("1 item(s) failed — a: io: copy: File name too long (os error 63)"),
      "unix",
    );
    expect(r.text, r.text).not.toMatch(/더 짧은 위치/);
  });

  it.fails("fileops-04: 이동(errno 22) 오류가 이유를 말한다", () => {
    // c02_move_into_child_preserves_source 실제 출력(macOS).
    const r = explainError(
      io("1 item(s) failed — a: io: Invalid argument (os error 22)"),
      "unix",
    );
    expect(r.text, r.text).toMatch(/하위|자기 자신|안으로/);
  });
});

describe("fileops-08 대소문자만 이름 바꾸기 — 토스트 문구", () => {
  it("'target exists' 가 '같은 이름이 이미 있음' 으로 안내된다(그리고 그것이 오해를 부른다)", () => {
    // ops::rename 오류(ops.rs:3100) — 인라인 입력 토스트 "이름 바꾸기 실패: {{err}}".
    const r = explainError(io("target exists: /w/A.txt"), "unix");
    // 기록용: 현재 문구.
    expect(r.text).toBe("입출력 오류 — target exists: /w/A.txt");
  });
});

describe("fileops-17 드라이브 간 이동 휴지통 실패 — 사본이 남았다는 안내", () => {
  it.fails("fileops-17: 토스트가 '받는 위치에 사본이 남음'을 말한다", () => {
    // c03_trash_failure_must_not_leave_unjournaled_copy 출력 모양. Windows 실제 휴지통 실패는
    // trash_many_blocking 의 Io("trash delete: …") (fs/local.rs:503-505).
    const r = explainError(
      io(
        "1 item(s) failed — a: io: trash delete: Error during a `trash` operation: Os { code: -2147024809, description: \"The parameter is incorrect.\" }",
      ),
      "windows",
    );
    expect(r.text, r.text).toMatch(/사본|남아|복사는 됐/);
  });
});
