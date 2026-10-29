import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        inquiry: resolve(import.meta.dirname, "inquiry.html"),
        login: resolve(import.meta.dirname, "login.html"),
      },
    },
  },
});
