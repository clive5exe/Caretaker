import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The build is served by bin/serve.mjs under a CSP of script-src 'self', so
// nothing may be inlined: no inline scripts, no inline module preload polyfill.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
});
