import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Separate from vite.config.js: the PWA plugin there has nothing to do
// with running tests and complicates the dev/test config for no benefit.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.js"],
  },
});
