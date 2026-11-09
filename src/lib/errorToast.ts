import i18n from "@/i18n";
import { explainError } from "@/lib/error";
import { basename } from "@/lib/paths";
import { useToast, type ToastFn } from "@/stores/toast";

/**
 * 오류 토스트 헬퍼 — 쉬운 문장과 원문을 함께 넘긴다.
 *
 * `formatErr` 만 쓰면 토스트에는 원인 문장만 남고 원문(어느 파일이, 백엔드가 뭐라고 했는지)은
 * 버려져 알림 목록 "자세히"에도 없었다(G-16). 여기서는 `explainError` 의 `text` 를 문장에,
 * `detail` 을 토스트 옵션으로 넘겨 알림 기록에 원문을 남긴다. 대상 경로를 아는 호출부는
 * `path` 를 넘기면 파일 이름(basename)이 문장 앞에 붙는다.
 */
export interface ShowErrorOptions {
  /** 실패한 대상 경로 — 표시용 이름(basename)을 문장에 넣고, 원문에 없으면 detail 앞에 붙인다. */
  path?: string | null | undefined;
  /** i18n 키의 다른 보간값 (`name`, `op` …). `err` 는 헬퍼가 채운다. */
  vars?: Record<string, unknown> | undefined;
  /** 주입된 토스트 함수(fileActions 등). 기본은 전역 토스트. */
  toast?: ToastFn | undefined;
}

/** 오류 토스트 문장(`message`)과 알림 "자세히"용 원문(`detail`). */
export function errorToastText(
  key: string,
  e: unknown,
  opts: ShowErrorOptions = {},
): { message: string; detail: string } {
  const why = explainError(e);
  const path = opts.path?.trim() || undefined;
  // 원문이 실제로 실패한 항목을 이미 말하면(why.target) 그 이름만 — 호출부 대상을 또 붙이지 않는다.
  const name = path && !why.target ? basename(path, path) : undefined;
  const err =
    name && !why.text.includes(name)
      ? i18n.t("errors.withName", { name, text: why.text })
      : why.text;
  const detail =
    path && !why.detail.includes(path)
      ? why.detail
        ? `${path}: ${why.detail}`
        : path
      : why.detail;
  return { message: i18n.t(key, { ...opts.vars, err }), detail };
}

/** `key`(`{{err}}` 자리를 가진 i18n 키)로 오류 토스트를 띄운다 — 원문은 알림 기록에. */
export function showError(
  key: string,
  e: unknown,
  opts: ShowErrorOptions = {},
): void {
  const { message, detail } = errorToastText(key, e, opts);
  const toast = opts.toast ?? useToast.getState().show;
  toast(message, "error", detail ? { detail } : undefined);
}
