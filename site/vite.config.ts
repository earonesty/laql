import { defineConfig } from "vite";

// Relative base so the same build works on GitHub Pages project pages
// (lakeql.com/) and on a custom domain (lakeql.com) without a rebuild.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
  },
});
