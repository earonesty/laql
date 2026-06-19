import { decompress } from "fzstd";
import type { Compressors } from "hyparquet/src/types.js";

export const lakeqlParquetCompressors: Compressors = {
  ZSTD(input, outputLength) {
    return decompress(input, new Uint8Array(outputLength));
  },
};
