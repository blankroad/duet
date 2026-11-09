import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { commands } from "@/types/bindings";
import { setTags } from "./tags";
import { useToast } from "./toast";
import { useNotices } from "./notices";

vi.mock("@/types/bindings", () => ({ commands: { tagSet: vi.fn() } }));
afterEach(async () => {
  useToast.getState().clear();
  useNotices.getState().clear();
  await i18n.changeLanguage("en");
});

it.each([
  ["ko", "태그 지정 실패:"],
  ["en", "Set tags failed:"],
])(
  "localizes a tag update failure in %s and preserves the backend original",
  async (language, prefix) => {
    await i18n.changeLanguage(language);
    const raw = "permission denied: /config/tags.json (os error 13)";
    vi.mocked(commands.tagSet).mockResolvedValue({
      status: "error",
      error: { kind: "PermissionDenied", message: raw },
    });
    await setTags("host:demo", ["work"]);
    const notice = useNotices.getState().items[0];
    expect(notice?.message).toContain(prefix);
    expect(notice?.detail).toContain(raw);
    expect(useToast.getState().toasts[0]?.kind).toBe("error");
  },
);
