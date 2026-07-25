import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const appRoot = resolve(import.meta.dirname, "app");

export default defineConfig({
  root: appRoot,
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(import.meta.dirname, "dist-app"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(appRoot, "plan-review.html"),
    },
  },
});
