import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      // CSS variables 기반 — 다크/라이트 모드 자동 적용
      // 모든 색상은 styles/globals.css 에서 정의
      //
      // 주의: bg-only 색 (base/subtle/active) 은 colors 에 두면 안 됨.
      // theme.fontSize.base 와 selector 충돌해서 `text-base` 가 font-size +
      // color 둘 다 정의되어 다크 모드에서 글자가 배경색이 됨. backgroundColor
      // 로 분리해서 `bg-base` 만 생성, `text-base` color 안 생기게.
      colors: {
        fg: {
          DEFAULT: "hsl(var(--fg-base) / <alpha-value>)",
          muted: "hsl(var(--fg-muted) / <alpha-value>)",
        },
        accent: "hsl(var(--accent) / <alpha-value>)",
        danger: "hsl(var(--danger) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        // 파일 종류 구분 색역 (globals.css --icon-*). text-icon-* 로 사용.
        // UI 강조색이 아닌 "정보 전달용 스코프 팔레트" — DESIGN.md 색상 절.
        icon: {
          code: "hsl(var(--icon-code) / <alpha-value>)",
          data: "hsl(var(--icon-data) / <alpha-value>)",
          doc: "hsl(var(--icon-doc) / <alpha-value>)",
          image: "hsl(var(--icon-image) / <alpha-value>)",
          audio: "hsl(var(--icon-audio) / <alpha-value>)",
          video: "hsl(var(--icon-video) / <alpha-value>)",
          archive: "hsl(var(--icon-archive) / <alpha-value>)",
          sheet: "hsl(var(--icon-sheet) / <alpha-value>)",
          key: "hsl(var(--icon-key) / <alpha-value>)",
          font: "hsl(var(--icon-font) / <alpha-value>)",
        },
      },
      backgroundColor: {
        base: "hsl(var(--bg-base) / <alpha-value>)",
        subtle: "hsl(var(--bg-subtle) / <alpha-value>)",
        active: "hsl(var(--bg-active) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "Cascadia Code", "SF Mono", "monospace"],
        // 워드마크/로고 전용 (번들된 woff2 — globals.css @font-face).
        brand: ['"Space Grotesk"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      // Fluent 절제형 토큰 — globals.css CSS 변수 매핑 (네임드로 두어 기존 rounded/shadow 무영향)
      borderRadius: {
        panel: "var(--radius)",
      },
      boxShadow: {
        panel: "var(--shadow)",
      },
      fontSize: {
        // 13px 베이스, 11px 메타, 15px 타이틀 (DESIGN.md 참조)
        meta: ["11px", { lineHeight: "1.4" }],
        base: ["13px", { lineHeight: "1.5" }],
        title: ["15px", { lineHeight: "1.4", fontWeight: "500" }],
      },
      // 총량 미상 진행률 바 — 좌→우 왕복 슬라이드(indeterminate).
      keyframes: {
        indeterminate: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
      },
      animation: {
        indeterminate: "indeterminate 1.2s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
