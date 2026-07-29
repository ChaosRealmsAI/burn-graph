import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  build: {
    outDir: new URL("../../dist/viewer", import.meta.url).pathname,
    emptyOutDir: true,
  },
});
