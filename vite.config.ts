import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Tauri는 dev 서버가 1420 포트에서 동작한다고 기대
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tauri의 src-tauri/ 변경은 감지 안 함 (Cargo가 따로 처리)
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    sourcemap: true,
  },
  // dependency scanner 가 root 의 모든 .html 을 entry 로 보지 않도록 명시.
  // 안 그러면 src-tauri/target/doc/ (cargo doc 결과물) 의 HTML 들까지
  // 스캔 대상이 되어 dev server 가 EPIPE 로 죽음.
  optimizeDeps: {
    entries: ["index.html"],
  },
});
