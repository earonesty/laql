import { describe, expect, it } from "vitest";
import { cachedRangeBuffer } from "./range-cache.js";
import type { StoreAsyncBuffer } from "./types.js";

describe("cachedRangeBuffer", () => {
  it("reuses exact byte ranges within a scan", async () => {
    let slices = 0;
    const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const file: StoreAsyncBuffer = {
      byteLength: source.byteLength,
      async slice(start, end) {
        slices += 1;
        return source.buffer.slice(start, end);
      },
    };
    const cached = cachedRangeBuffer(file, { maxBytes: 6 });

    await expect(bytes(cached.slice(1, 4))).resolves.toEqual([2, 3, 4]);
    await expect(bytes(cached.slice(1, 4))).resolves.toEqual([2, 3, 4]);
    await expect(bytes(cached.slice(2, 5))).resolves.toEqual([3, 4, 5]);

    expect(slices).toBe(2);
  });

  it("does not cache ranges larger than the entry budget", async () => {
    let slices = 0;
    const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const file: StoreAsyncBuffer = {
      byteLength: source.byteLength,
      async slice(start, end) {
        slices += 1;
        return source.buffer.slice(start, end);
      },
    };
    const cached = cachedRangeBuffer(file, { maxBytes: 6, maxEntryBytes: 2 });

    await cached.slice(0, 3);
    await cached.slice(0, 3);

    expect(slices).toBe(2);
  });
});

async function bytes(input: Promise<ArrayBuffer>): Promise<number[]> {
  return [...new Uint8Array(await input)];
}
