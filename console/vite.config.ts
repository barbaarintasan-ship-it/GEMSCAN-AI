import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs so the built app runs from any location — local preview or
  // a static host serving it from a sub-path (e.g. GitHub Pages /repo/). Supabase's
  // own domains can't serve the HTML (they force text/plain on it), so it is hosted
  // elsewhere; paired with HashRouter so deep links work without server rewrites.
  base: "./",
  plugins: [react()],
  server: { port: 5173 },
});
