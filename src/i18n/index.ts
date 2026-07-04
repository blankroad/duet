import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import ko from "./ko.json";

/**
 * i18n 부트스트랩 — main.tsx 에서 App 보다 먼저 import.
 *
 * - 리소스는 번들 내장(en/ko JSON) — 오프라인/CSP 안전
 * - 언어 설정은 localStorage(비민감 UI 설정, splitExt 등과 동일 패턴)
 * - "system" 은 navigator.language 로 해석 (ko* → ko, 그 외 en)
 * - 미번역 키는 en 으로 fallback — 단계적 마이그레이션 전제
 */

const LANG_KEY = "duet.lang";

export type LangSetting = "system" | "en" | "ko";

export function storedLang(): LangSetting {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "en" || v === "ko" ? v : "system";
  } catch {
    return "system";
  }
}

function resolve(setting: LangSetting): "en" | "ko" {
  if (setting === "en" || setting === "ko") return setting;
  return typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("ko")
    ? "ko"
    : "en";
}

/** 언어 설정 변경 — 영속 + 즉시 적용 (useTranslation 구독 컴포넌트 리렌더). */
export function setLang(setting: LangSetting): void {
  try {
    localStorage.setItem(LANG_KEY, setting);
  } catch {
    /* localStorage 불가 — 메모리 상태만 */
  }
  void i18n.changeLanguage(resolve(setting));
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ko: { translation: ko },
  },
  lng: resolve(storedLang()),
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React 가 이미 XSS-safe
});

export default i18n;
