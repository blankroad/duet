import { useEffect } from "react";
import i18n from "@/i18n";
import { events, type ArchiveNoticeEvent } from "@/types/bindings";
import { useToast } from "@/stores/toast";

/**
 * 백엔드 `archive-notice-event` 구독 — 해제(또는 내부 보기)는 끝났지만 일부 링크를
 * 건너뛰었거나 이 OS 에서 쓸 수 없는 이름을 바꿨을 때 경고 토스트로 알린다.
 * 항목 이름은 알림 기록의 "자세히"에 남긴다.
 */
export function useArchiveNoticeEvents() {
  useEffect(() => {
    const unlistenP = events.archiveNoticeEvent.listen(({ payload }) => {
      const { message, detail } = describeArchiveNotice(payload);
      useToast.getState().show(message, "warning", { detail });
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []);
}

/** 알림 문장 + 자세히(항목 목록). 테스트용으로 분리. */
export function describeArchiveNotice(n: ArchiveNoticeEvent): {
  message: string;
  detail: string;
} {
  const parts: string[] = [];
  if (n.skipped_links_count > 0)
    parts.push(
      i18n.t("toast.archiveLinksSkipped", { count: n.skipped_links_count }),
    );
  if (n.renamed_count > 0)
    parts.push(i18n.t("toast.archiveRenamed", { count: n.renamed_count }));
  const list = (title: string, names: string[], total: number) => {
    const more = total - names.length;
    return [
      title,
      ...names.map((name) => `  ${name}`),
      ...(more > 0 ? [`  ${i18n.t("notices.more", { count: more })}`] : []),
    ];
  };
  const detail = [
    ...(n.skipped_links_count > 0
      ? list(
          i18n.t("notices.skippedLinks"),
          n.skipped_links,
          n.skipped_links_count,
        )
      : []),
    ...(n.renamed_count > 0
      ? list(i18n.t("notices.renamed"), n.renamed, n.renamed_count)
      : []),
  ].join("\n");
  return {
    message: i18n.t("toast.archiveNotice", {
      name: n.archive_name,
      details: parts.join(" "),
    }),
    detail,
  };
}
