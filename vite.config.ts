import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/Configurex/" : "/",
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    server: { deps: { inline: ["codemirror-json-schema"] } },
    setupFiles: "./vitest.setup.ts",
  },
}));
