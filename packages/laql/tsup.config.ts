import { defineConfig } from "tsup";

// `laql` is published as a single self-contained package: the internal
// `@laql/*` workspace sources are inlined, while the real runtime dependencies
// (Parquet/Avro/crypto/geo libraries) stay external and are declared in
// package.json so consumers install one package with a small dependency set.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    cloudflare: "src/cloudflare.ts",
  },
  format: ["esm"],
  // resolve inlines the @laql/* workspace type declarations into the bundle
  // so consumers don't need the (unpublished) internal packages for types.
  dts: { resolve: true },
  clean: true,
  treeshake: true,
  sourcemap: false,
  // Inline the workspace packages; keep declared runtime deps external.
  noExternal: [/^@laql\//],
  external: [
    "@turf/boolean-contains",
    "@turf/boolean-intersects",
    "avsc",
    "aws4fetch",
    "fast-xml-parser",
    "h3-js",
    "hyparquet",
    "hyparquet-writer",
  ],
});
