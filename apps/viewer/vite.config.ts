import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import path from "node:path";

const viewerRoot = new URL(".", import.meta.url).pathname;

export default defineConfig({
  root: viewerRoot,
  plugins: [react()],
  build: {
    outDir: new URL("../../dist/viewer", import.meta.url).pathname,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        viewer: path.resolve(viewerRoot, "index.html"),
        render: path.resolve(viewerRoot, "render.html"),
      },
    },
  },
});
