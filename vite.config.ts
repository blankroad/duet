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
});
