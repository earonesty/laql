// The ONLY module that statically imports the heavy geospatial libraries
// (@turf/* and h3-js). It is never part of the static import graph of the
// evaluator or query engine — `evaluator.ts` reaches it through a dynamic
// `import("./geo-backend.js")` (see `ensureGeoBackendForExprs`), which bundlers
// split into a separate chunk. A query that uses no exact-geometry/H3 spatial
// function never loads this module, so turf + h3-js stay out of the bundle.
import { booleanContains } from "@turf/boolean-contains";
import { booleanIntersects } from "@turf/boolean-intersects";
import { cellToParent, gridDisk, isValidCell, latLngToCell } from "h3-js";
import { type GeoBackend, setGeoBackend } from "./evaluator.js";

const backend: GeoBackend = {
  booleanContains,
  booleanIntersects,
  cellToParent,
  gridDisk,
  isValidCell,
  latLngToCell,
};

/** Register the turf/h3-backed primitives with the evaluator. Idempotent. */
export function installGeoBackend(): void {
  setGeoBackend(backend);
}
