import { defineConfig } from "vite";

// Relative base so the same build works on GitHub Pages project pages
// (earonesty.github.io/laql/) and on a custom domain (laql.dev) without a rebuild.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
  },
});
