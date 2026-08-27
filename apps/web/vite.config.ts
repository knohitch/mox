import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// HTML5 History SPA (Prompt 01): the app uses real paths (not hashes), so the
// dev/preview servers must fall back to index.html for any unmatched URL.
// Vite does this automatically in SPA mode; the PRODUCTION static host must be
// configured with an equivalent rewrite (never serve a 404 at a real path).
export default defineConfig({
  plugins: [react()],
  appType: "spa",
  server: {
    port: 5173,
  },
});
