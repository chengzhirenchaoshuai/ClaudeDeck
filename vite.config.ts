import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // 前端静态资源统一放在 assets/public
  publicDir: "assets/public",

  // 主包约 1.5 MB：React、TipTap 输入框、Markdown 渲染（含 highlight.js）首屏都要用，
  // 拆出去也不会减少启动解析量；KaTeX、CodeMirror 已按需懒加载。
  // 前端从本地磁盘加载，没有网络下载开销。阈值略高于现状，主包继续变大时仍会告警。
  build: {
    chunkSizeWarningLimit: 1600,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
