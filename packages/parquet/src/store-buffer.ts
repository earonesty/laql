import {
  LakeqlError,
  type ObjectInfo,
  type ObjectStore,
  type ScanOptions,
  throwIfAborted,
  withObjectStoreReadControls,
} from "lakeql-core";
import type { StoreAsyncBuffer } from "./types.js";

/**
 * Bridge an ObjectStore path to hyparquet's AsyncBuffer (length + ranged slice).
 */
export async function asyncBufferFromStore(
  store: ObjectStore,
  path: string,
  options: ScanOptions | undefined = undefined,
) {
  const controlledStore =
    options === undefined ? store : withObjectStoreReadControls(store, options.budget);
  throwIfAborted(options?.budget.signal);
  const head = await controlledStore.head(path);
  if (!head) {
    throw new LakeqlError("LAKEQL_OBJECT_NOT_FOUND", `No object at ${path}`, { path });
  }
  return storeAsyncBuffer(controlledStore, path, head.size, head.etag, options);
}

export function asyncBufferFromObjectInfo(
  store: ObjectStore,
  object: ObjectInfo,
  options: ScanOptions | undefined = undefined,
): StoreAsyncBuffer {
  const controlledStore =
    options === undefined ? store : withObjectStoreReadControls(store, options.budget);
  return storeAsyncBuffer(controlledStore, object.path, object.size, object.etag, options);
}

function storeAsyncBuffer(
  store: ObjectStore,
  path: string,
  byteLength: number,
  etag: string | undefined,
  options: ScanOptions | undefined,
): StoreAsyncBuffer {
  const buffer: StoreAsyncBuffer = {
    byteLength,
    slice: async (start: number, end?: number): Promise<ArrayBuffer> => {
      const length = (end ?? byteLength) - start;
      if (options) {
        throwIfAborted(options.budget.signal);
        options.stats.rangeRequests += 1;
        options.stats.bytesRequested += length;
      }
      const bytes = await store.getRange(path, { offset: start, length });
      throwIfAborted(options?.budget.signal);
      return bytesToArrayBuffer(bytes);
    },
  };
  if (etag !== undefined) buffer.etag = etag;
  return buffer;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
