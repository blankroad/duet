import { useEffect } from "react";
import i18n from "@/i18n";
import { commands, type StartupNotice } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { basename } from "@/lib/paths";

/**
 * 시작할 때 백엔드가 고치고 넘어간 저장 파일 문제(깨진 설정 파일을 옆으로 옮기고 기본값으로
 * 시작, journal 의 깨진 줄 건너뜀)를 마운트 후 한 번 가져와 경고 토스트로 알린다.
 * 경로·파싱 오류 원문은 알림 기록의 "자세히"에 남긴다.
 *
 * 이벤트가 아니라 IPC 로 가져오는 이유: 백엔드는 창이 뜨기 전에 로드하므로 이벤트를 쏘면
 * 아무도 듣지 않아 사라진다. 백엔드는 한 번 꺼내면 비우므로 새로고침해도 다시 뜨지 않는다.
 */
export function useStartupNotices() {
  useEffect(() => {
    void (async () => {
      const r = await commands.startupNoticesTake();
      if (r.status !== "ok") return;
      for (const n of r.data) {
        const { message, detail } = describeStartupNotice(n);
        useToast.getState().show(message, "warning", { detail });
      }
    })();
  }, []);
}

/** 알림 문장 + 자세히. 테스트용으로 분리. */
export function describeStartupNotice(n: StartupNotice): {
  message: string;
  detail: string;
} {
  const file = String(n.file);
  const name = basename(file, file);
  const a = n.action;
  if (a.kind === "reset") {
    const backup = String(a.backup);
    return {
      message: i18n.t("toast.startupFileReset", {
        name,
        backup: basename(backup, backup),
      }),
      detail: [
        i18n.t("notices.file", { path: file }),
        i18n.t("notices.backup", { path: backup }),
        n.detail,
      ].join("\n"),
    };
  }
  const backup = a.backup == null ? null : String(a.backup);
  return {
    message: i18n.t("toast.startupLinesSkipped", { name, count: a.count }),
    detail: [
      i18n.t("notices.file", { path: file }),
      ...(backup ? [i18n.t("notices.backup", { path: backup })] : []),
      n.detail,
    ].join("\n"),
  };
}
