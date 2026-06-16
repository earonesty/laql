// Deterministic fixture generation: same input, same bytes, no clock, no RNG.
// Run via `pnpm fixtures` (root) or `pnpm generate` (this package).
import { Buffer } from "node:buffer";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import avro from "avsc";
import { parquetWriteFile } from "hyparquet-writer";
import {
  fixtureDataDir,
  fixturePath,
  GEO,
  GROUPBY,
  H3,
  HIVE,
  ICEBERG,
  MANIFESTS,
  SALES,
  STATS,
  TYPES,
  WIDE,
  WRITE,
} from "./index.ts";

mkdirSync(fixtureDataDir, { recursive: true });

function generateSales() {
  const n = SALES.rows;
  const storeId: string[] = [];
  const date: string[] = [];
  const amount: number[] = [];
  const region: string[] = [];

  for (let i = 0; i < n; i++) {
    storeId.push(`store-${String(i % 7).padStart(3, "0")}`);
    date.push(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`);
    amount.push(((i * 37) % 1000) + i / 100);
    region.push(SALES.regions[i % SALES.regions.length] as string);
  }

  parquetWriteFile({
    filename: fixturePath(SALES.file),
    rowGroupSize: [SALES.rowGroupSize],
    columnData: [
      { name: "store_id", data: storeId, type: "STRING" },
      { name: "date", data: date, type: "STRING" },
      { name: "amount", data: amount, type: "DOUBLE" },
      { name: "region", data: region, type: "STRING" },
    ],
  });
}

function generateTypes() {
  const n = TYPES.rows;
  const id: number[] = [];
  const big: bigint[] = [];
  const flag: boolean[] = [];
  const name: (string | null)[] = [];
  const score: number[] = [];

  for (let i = 0; i < n; i++) {
    id.push(i);
    big.push(9007199254740991n + BigInt(i)); // crosses MAX_SAFE_INTEGER
    flag.push(i % 2 === 0);
    name.push(i % 3 === 0 ? null : `name-${i}`);
    score.push(i * 1.5);
  }

  parquetWriteFile({
    filename: fixturePath(TYPES.file),
    columnData: [
      { name: "id", data: id, type: "INT32" },
      { name: "big", data: big, type: "INT64" },
      { name: "flag", data: flag, type: "BOOLEAN" },
      { name: "name", data: name, type: "STRING", nullable: true },
      { name: "score", data: score, type: "DOUBLE" },
    ],
  });
}

function generateWide() {
  const columnData: { name: string; data: number[]; type: "INT32" }[] = [];
  for (let c = 0; c < WIDE.columns; c++) {
    const data: number[] = [];
    for (let row = 0; row < WIDE.rows; row++) data.push(c * 1000 + row);
    columnData.push({ name: `c${String(c).padStart(2, "0")}`, data, type: "INT32" });
  }

  parquetWriteFile({
    filename: fixturePath(WIDE.file),
    columnData,
  });
}

function generateStats() {
  const id: number[] = [];
  const metric: number[] = [];
  const label: string[] = [];

  for (let group = 0; group < 3; group++) {
    for (let offset = 0; offset < STATS.rowGroupSize; offset++) {
      const value = group * 100 + offset;
      id.push(group * STATS.rowGroupSize + offset);
      metric.push(value);
      label.push(`g${group}`);
    }
  }

  parquetWriteFile({
    filename: fixturePath(STATS.file),
    rowGroupSize: [STATS.rowGroupSize],
    columnData: [
      { name: "id", data: id, type: "INT32" },
      { name: "metric", data: metric, type: "INT32" },
      { name: "label", data: label, type: "STRING" },
    ],
  });
}

function generateGroupby() {
  parquetWriteFile({
    filename: fixturePath(GROUPBY.file),
    rowGroupSize: [4],
    columnData: [
      {
        name: "region",
        data: ["west", "west", "east", "east", "north", "north", "south", "south"],
        type: "STRING",
      },
      { name: "amount", data: [10, 20, 7, 13, 5, 15, 2, 8], type: "INT32" },
      { name: "id", data: [1, 2, 3, 4, 5, 6, 7, 8], type: "INT32" },
      { name: "label", data: ["w1", "w2", "e1", "e2", "n1", "n2", "s1", "s2"], type: "STRING" },
    ],
  });
}

function generateGeo() {
  parquetWriteFile({
    filename: fixturePath(GEO.file),
    rowGroupSize: [GEO.rowGroupSize],
    columnData: [
      { name: "id", data: [1, 2, 3], type: "INT32" },
      { name: "name", data: ["downtown", "valley", "harbor"], type: "STRING" },
      {
        name: "geom",
        data: [
          JSON.stringify({ type: "Point", coordinates: [-118.24, 34.05] }),
          JSON.stringify({ type: "Point", coordinates: [-118.45, 34.18] }),
          JSON.stringify({ type: "Point", coordinates: [-117.16, 32.72] }),
        ],
        type: "STRING",
      },
      { name: "minx", data: [-118.24, -118.45, -117.16], type: "DOUBLE" },
      { name: "miny", data: [34.05, 34.18, 32.72], type: "DOUBLE" },
      { name: "maxx", data: [-118.24, -118.45, -117.16], type: "DOUBLE" },
      { name: "maxy", data: [34.05, 34.18, 32.72], type: "DOUBLE" },
    ],
  });
}

function generateH3() {
  parquetWriteFile({
    filename: fixturePath(H3.file),
    rowGroupSize: [H3.rowGroupSize],
    columnData: [
      { name: "id", data: [1, 2, 3, 4], type: "INT32" },
      {
        name: "h3_7",
        data: ["8729a1d75ffffff", "8729a1d75ffffff", "8729a1d74ffffff", "8729a1d76ffffff"],
        type: "STRING",
      },
      {
        name: "h3_8",
        data: ["8829a1d757fffff", "8829a1d753fffff", "8829a1d74bfffff", "8829a1d765fffff"],
        type: "STRING",
      },
    ],
  });
}

function generateWriteGolden() {
  const path = fixturePath(WRITE.file);
  mkdirSync(dirname(path), { recursive: true });
  parquetWriteFile({
    filename: path,
    rowGroupSize: [2],
    columnData: [
      { name: "id", data: [1, 2, 3], type: "INT32" },
      { name: "name", data: ["a", "b", "c"], type: "STRING" },
      { name: "score", data: [1.5, 2.5, 3.5], type: "DOUBLE" },
    ],
  });
}

function generateManifestGoldens() {
  const taskInput = {
    path: "b.parquet",
    etag: "v2",
    rowGroupRanges: [
      { start: 10, end: 20 },
      { start: 0, end: 10 },
    ],
    projectedColumns: ["z", "a"],
    partitionValues: { country: "US", date: "2026-01-01" },
  };
  const normalizedTaskInput = normalizeTaskInput(taskInput);
  const taskManifest = {
    version: 1,
    jobId: "job_2",
    planFingerprint: fingerprint({
      version: 1,
      snapshot: "snapshot_2",
      tasks: [normalizedTaskInput],
    }),
    snapshot: "snapshot_2",
    tasks: [
      {
        id: taskId("job_2", 0, taskInput),
        input: normalizedTaskInput,
        outputRole: "data-file",
      },
    ],
  };
  const outputEntry = {
    taskId: taskManifest.tasks[0]?.id ?? "",
    outputPath: "out/date=2026-01-01/file.parquet",
    partitionValues: { country: "US", date: "2026-01-01" },
    rowCount: 12,
    byteSize: 256,
    contentHash: "sha256:abc",
    etag: "out-v1",
    iceberg: {
      recordCount: 12,
      fileSizeInBytes: 256,
      partitionValues: { country: "US", date: "2026-01-01" },
    },
  };
  const bookmark = {
    version: 1,
    planFingerprint: "fp_0123456789abcdef",
    snapshot: "snapshot_1",
    position: {
      fileIndex: 1,
      rowGroup: 2,
      rowOffset: 3,
      taskId: "job-task-000001-deadbeef",
      outputManifestCursor: 4,
    },
  };
  const retryLog = [
    {
      taskId: "job_4-task-000001-a",
      state: "planned",
      idempotencyKey: "idem-1",
      updatedAtMs: 10,
    },
    {
      taskId: "job_4-task-000001-a",
      state: "running",
      idempotencyKey: "idem-1",
      updatedAtMs: 20,
    },
    {
      taskId: "job_4-task-000001-a",
      state: "running",
      idempotencyKey: "idem-2",
      updatedAtMs: 100,
    },
    {
      taskId: "job_4-task-000001-a",
      state: "output-written",
      idempotencyKey: "idem-2",
      updatedAtMs: 110,
      output: {
        taskId: "job_4-task-000001-a",
        outputPath: "out/file.parquet",
        partitionValues: {},
        rowCount: 1,
        byteSize: 2,
      },
    },
  ];

  writeJsonFixture(MANIFESTS.taskManifest, taskManifest);
  const parquetTaskInput = normalizeTaskInput({
    path: "data/stats.parquet",
    etag: "v1",
    size: 1152,
    rowGroupRanges: [{ start: 1, end: 3 }],
    projectedColumns: ["id", "metric"],
    partitionValues: {},
    residualPredicate: {
      kind: "compare",
      left: { kind: "column", name: "metric" },
      op: "gte",
      right: { kind: "literal", value: 100 },
    },
  });
  writeJsonFixture(MANIFESTS.parquetTaskManifest, {
    version: 1,
    jobId: "job_stats",
    planFingerprint: fingerprint({
      version: 1,
      snapshot: fingerprint([{ etag: "v1", path: "data/stats.parquet", size: 1152 }]),
      tasks: [parquetTaskInput],
    }),
    snapshot: fingerprint([{ etag: "v1", path: "data/stats.parquet", size: 1152 }]),
    tasks: [
      {
        id: taskId("job_stats", 0, parquetTaskInput),
        input: parquetTaskInput,
        outputRole: "rows",
      },
    ],
  });
  writeJsonFixture(MANIFESTS.outputManifest, {
    version: 1,
    jobId: "job_2",
    planFingerprint: taskManifest.planFingerprint,
    entries: [normalizeOutputEntry(outputEntry)],
  });
  writeJsonFixture(MANIFESTS.bookmark, bookmark);
  writeJsonFixture(MANIFESTS.retryLog, retryLog);
}

function generateHive() {
  for (const file of HIVE.files) {
    writeHiveLikeParquet(file);
  }
  for (const file of ICEBERG.dataFiles) {
    writeHiveLikeParquet(file);
  }
}

function writeHiveLikeParquet(file: string): void {
  const path = fixturePath(file);
  mkdirSync(dirname(path), { recursive: true });
  const country = file.includes("country=CA") ? "CA" : "US";
  const date = file.includes("date=2026-01-01") ? "2026-01-01" : "2026-01-02";
  const base = country === "CA" ? 100 : date.endsWith("01") ? 0 : 200;
  const id: number[] = [];
  const amount: number[] = [];
  for (let i = 0; i < HIVE.rowsPerFile; i++) {
    id.push(base + i);
    amount.push(base + i * 10);
  }
  parquetWriteFile({
    filename: path,
    columnData: [
      { name: "id", data: id, type: "INT32" },
      { name: "amount", data: amount, type: "INT32" },
    ],
  });
}

async function generateIceberg() {
  mkdirSync(dirname(fixturePath(ICEBERG.metadataFile)), { recursive: true });
  const manifest1Json = {
    path: ICEBERG.legacyManifestFiles[0],
    files: [
      {
        path: ICEBERG.dataFiles[0],
        sequenceNumber: 1,
        partition: { country: "US", date: "2026-01-01" },
        recordCount: HIVE.rowsPerFile,
        fileSizeInBytes: fixtureSize(ICEBERG.dataFiles[0]),
      },
      {
        path: ICEBERG.dataFiles[1],
        sequenceNumber: 2,
        partition: { country: "CA", date: "2026-01-02" },
        recordCount: HIVE.rowsPerFile,
        fileSizeInBytes: fixtureSize(ICEBERG.dataFiles[1]),
      },
    ],
  };
  const manifest2Json = {
    path: ICEBERG.legacyManifestFiles[1],
    files: [
      {
        path: ICEBERG.dataFiles[0],
        sequenceNumber: 1,
        partition: { country: "US", date: "2026-01-01" },
        recordCount: HIVE.rowsPerFile,
        fileSizeInBytes: fixtureSize(ICEBERG.dataFiles[0]),
        deleteFiles: [{ content: "position-delete", path: ICEBERG.positionDeleteFile }],
      },
      {
        path: ICEBERG.dataFiles[1],
        sequenceNumber: 2,
        partition: { country: "CA", date: "2026-01-02" },
        recordCount: HIVE.rowsPerFile,
        fileSizeInBytes: fixtureSize(ICEBERG.dataFiles[1]),
        deleteFiles: [{ content: "equality-delete", path: ICEBERG.equalityDeleteFile }],
      },
      {
        path: ICEBERG.dataFiles[2],
        sequenceNumber: 3,
        partition: { country: "US", date: "2026-01-02" },
        recordCount: HIVE.rowsPerFile,
        fileSizeInBytes: fixtureSize(ICEBERG.dataFiles[2]),
      },
    ],
  };
  const manifest1Path = ICEBERG.manifestFiles[0];
  const manifest2DataPath = ICEBERG.manifestFiles[1];
  const manifest2DeletesPath = ICEBERG.manifestFiles[2];
  const manifest2UsPath = "iceberg/warehouse/places/metadata/manifest-2-us.avro";
  const manifest2CaPath = "iceberg/warehouse/places/metadata/manifest-2-ca.avro";
  await writeAvroFixture(
    manifest1Path,
    icebergManifestEntrySchema(),
    manifest1Json.files.map((file) => avroDataManifestEntry(file, 1)),
  );
  await writeAvroFixture(
    ICEBERG.v1ManifestFile,
    icebergV1ManifestEntrySchema(),
    manifest1Json.files.map((file) => avroV1DataManifestEntry(file, 1)),
  );
  await writeAvroFixture(ICEBERG.v1ManifestListFile, icebergV1ManifestListSchema(), [
    avroV1ManifestListEntry(
      ICEBERG.v1ManifestFile,
      1,
      manifest1Json.files.length,
      HIVE.rowsPerFile * 2,
    ),
  ]);
  await writeAvroFixture(
    manifest2DataPath,
    icebergManifestEntrySchema(),
    manifest2Json.files.map((file) => avroDataManifestEntry(file, 2)),
  );
  await writeAvroFixture(manifest2DeletesPath, icebergManifestEntrySchema(), [
    avroDeleteManifestEntry({
      path: ICEBERG.positionDeleteFile,
      content: 1,
      partition: { country: "US", date: "2026-01-01" },
      recordCount: 1,
      fileSizeInBytes: fixtureSize(ICEBERG.positionDeleteFile),
      sequenceNumber: 2,
    }),
    avroDeleteManifestEntry({
      path: ICEBERG.equalityDeleteFile,
      content: 2,
      partition: { country: "CA", date: "2026-01-02" },
      recordCount: 1,
      fileSizeInBytes: fixtureSize(ICEBERG.equalityDeleteFile),
      sequenceNumber: 2,
    }),
  ]);
  await writeAvroFixture(
    manifest2UsPath,
    icebergManifestEntrySchema(),
    manifest2Json.files
      .filter((file) => file.partition.country === "US")
      .map((file) => avroDataManifestEntry(file, 2)),
  );
  await writeAvroFixture(
    manifest2CaPath,
    icebergManifestEntrySchema(),
    manifest2Json.files
      .filter((file) => file.partition.country === "CA")
      .map((file) => avroDataManifestEntry(file, 2)),
  );
  await writeAvroFixture(ICEBERG.manifestListFile, icebergManifestListSchema(), [
    avroManifestListEntry(manifest2DataPath, 0, 2, 3, HIVE.rowsPerFile * 3),
    avroManifestListEntry(manifest2DeletesPath, 1, 2, 2, 2),
  ]);
  const metadata = {
    "format-version": 2,
    "table-uuid": "00000000-0000-4000-8000-000000000001",
    location: ICEBERG.tableLocation,
    "current-snapshot-id": 2,
    refs: {
      main: { type: "branch", "snapshot-id": 2 },
      previous: { type: "tag", "snapshot-id": 1 },
    },
    schemas: [
      {
        "schema-id": 1,
        fields: [
          { id: 1, name: "id", type: "int", required: true },
          { id: 2, name: "amount", type: "int", required: false },
          { id: 3, name: "country", type: "string", required: false },
        ],
      },
      {
        "schema-id": 2,
        fields: [
          { id: 1, name: "id", type: "int", required: true },
          { id: 2, name: "amount", type: "int", required: false },
          { id: 4, name: "nation", sourceId: 3, type: "string", required: false },
        ],
      },
    ],
    snapshots: [
      {
        "snapshot-id": 1,
        "timestamp-ms": 1_767_225_600_000,
        "schema-id": 1,
        manifests: [{ path: manifest1Path }],
      },
      {
        "snapshot-id": 2,
        "timestamp-ms": 1_767_312_000_000,
        "schema-id": 2,
        "manifest-list": ICEBERG.manifestListFile,
      },
    ],
  };
  writeFileSync(fixturePath(ICEBERG.metadataFile), `${JSON.stringify(metadata, null, 2)}\n`);
  const v1Metadata = {
    ...metadata,
    "format-version": 1,
    "current-snapshot-id": 1,
    "current-schema-id": 1,
    snapshots: [
      {
        "snapshot-id": 1,
        "timestamp-ms": 1_767_225_600_000,
        "schema-id": 1,
        "manifest-list": ICEBERG.v1ManifestListFile,
      },
    ],
    refs: undefined,
  };
  writeFileSync(fixturePath(ICEBERG.v1MetadataFile), `${JSON.stringify(v1Metadata, null, 2)}\n`);
  for (const manifest of [manifest1Json, manifest2Json]) {
    writeFileSync(fixturePath(manifest.path), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const manifestRefMetadata = {
    ...metadata,
    snapshots: metadata.snapshots.map((snapshot) => ({
      ...snapshot,
      "manifest-list": undefined,
      manifests:
        snapshot["snapshot-id"] === 2
          ? [{ path: manifest2DataPath }, { path: manifest2DeletesPath }]
          : [{ path: manifest1Path }],
    })),
  };
  writeFileSync(
    fixturePath(ICEBERG.manifestRefMetadataFile),
    `${JSON.stringify(manifestRefMetadata, null, 2)}\n`,
  );
  writeFileSync(
    fixturePath(ICEBERG.legacyManifestListFile),
    `${JSON.stringify({ manifests: [manifest2Json] }, null, 2)}\n`,
  );
  const manifestListMetadata = {
    ...metadata,
    snapshots: metadata.snapshots.map((snapshot) =>
      snapshot["snapshot-id"] === 2
        ? {
            ...snapshot,
            "manifest-list": ICEBERG.manifestListFile,
            manifests: undefined,
          }
        : snapshot,
    ),
  };
  writeFileSync(
    fixturePath(ICEBERG.manifestListMetadataFile),
    `${JSON.stringify(manifestListMetadata, null, 2)}\n`,
  );
  const multiManifestMetadata = {
    ...metadata,
    snapshots: metadata.snapshots.map((snapshot) =>
      snapshot["snapshot-id"] === 2
        ? {
            ...snapshot,
            manifests: [
              { path: manifest2UsPath },
              { path: manifest2CaPath },
              { path: manifest2DeletesPath },
            ],
          }
        : snapshot,
    ),
  };
  writeFileSync(
    fixturePath(ICEBERG.multiManifestMetadataFile),
    `${JSON.stringify(multiManifestMetadata, null, 2)}\n`,
  );
  writeJsonFixture(ICEBERG.plannedFilesGolden, {
    snapshotId: 2,
    files: manifest2Json.files
      .filter((file) => file.partition.country === "US")
      .map((file) => ({
        path: file.path,
        sequenceNumber: file.sequenceNumber,
        partition: file.partition,
        recordCount: file.recordCount,
        fileSizeInBytes: file.fileSizeInBytes,
        projectedFieldIds: [1, 3],
        snapshotId: 2,
        ...(file.deleteFiles !== undefined
          ? {
              deleteFiles: file.deleteFiles.map((deleteFile) => ({
                content: deleteFile.content,
                path: deleteFile.path,
              })),
            }
          : {}),
      })),
  });
  writeJsonFixture(ICEBERG.plannedTasksGolden, {
    snapshotId: 2,
    tasks: [
      {
        path: ICEBERG.dataFiles[0],
        partition: { country: "US", date: "2026-01-01" },
        rowGroupRanges: [],
      },
      {
        path: ICEBERG.dataFiles[2],
        partition: { country: "US", date: "2026-01-02" },
        rowGroupRanges: [{ start: 0, end: 1 }],
      },
    ],
  });
}

function fixtureSize(path: string): number {
  return statSync(fixturePath(path)).size;
}

function icebergManifestListSchema(): unknown {
  return {
    type: "record",
    name: "manifest_file",
    fields: [
      { name: "manifest_path", type: "string" },
      { name: "manifest_length", type: "long" },
      { name: "partition_spec_id", type: "int" },
      { name: "content", type: "int" },
      { name: "sequence_number", type: "long" },
      { name: "min_sequence_number", type: "long" },
      { name: "added_snapshot_id", type: "long" },
      { name: "added_files_count", type: "int" },
      { name: "existing_files_count", type: "int" },
      { name: "deleted_files_count", type: "int" },
      { name: "added_rows_count", type: "long" },
      { name: "existing_rows_count", type: "long" },
      { name: "deleted_rows_count", type: "long" },
      { name: "partitions", type: "null", default: null },
    ],
  };
}

function icebergManifestEntrySchema(): unknown {
  return {
    type: "record",
    name: "manifest_entry",
    fields: [
      { name: "status", type: "int" },
      { name: "snapshot_id", type: ["null", "long"], default: null },
      { name: "sequence_number", type: ["null", "long"], default: null },
      { name: "file_sequence_number", type: ["null", "long"], default: null },
      {
        name: "data_file",
        type: {
          type: "record",
          name: "data_file",
          fields: [
            { name: "content", type: "int" },
            { name: "file_path", type: "string" },
            {
              name: "file_format",
              type: { type: "enum", name: "file_format", symbols: ["PARQUET"] },
            },
            {
              name: "partition",
              type: {
                type: "record",
                name: "partition",
                fields: [
                  { name: "country", type: ["null", "string"], default: null },
                  { name: "date", type: ["null", "string"], default: null },
                ],
              },
            },
            { name: "record_count", type: "long" },
            { name: "file_size_in_bytes", type: "long" },
            {
              name: "equality_ids",
              type: ["null", { type: "array", items: "int" }],
              default: null,
            },
          ],
        },
      },
    ],
  };
}

function icebergV1ManifestListSchema(): unknown {
  return {
    type: "record",
    name: "manifest_file",
    fields: [
      { name: "manifest_path", type: "string" },
      { name: "manifest_length", type: "long" },
      { name: "partition_spec_id", type: "int" },
      { name: "added_snapshot_id", type: "long" },
      { name: "added_files_count", type: "int" },
      { name: "existing_files_count", type: "int" },
      { name: "deleted_files_count", type: "int" },
      { name: "added_rows_count", type: "long" },
      { name: "existing_rows_count", type: "long" },
      { name: "deleted_rows_count", type: "long" },
      { name: "partitions", type: "null", default: null },
    ],
  };
}

function icebergV1ManifestEntrySchema(): unknown {
  return {
    type: "record",
    name: "manifest_entry",
    fields: [
      { name: "status", type: "int" },
      { name: "snapshot_id", type: ["null", "long"], default: null },
      {
        name: "data_file",
        type: {
          type: "record",
          name: "data_file",
          fields: [
            { name: "file_path", type: "string" },
            {
              name: "file_format",
              type: { type: "enum", name: "file_format", symbols: ["PARQUET"] },
            },
            {
              name: "partition",
              type: {
                type: "record",
                name: "partition",
                fields: [
                  { name: "country", type: ["null", "string"], default: null },
                  { name: "date", type: ["null", "string"], default: null },
                ],
              },
            },
            { name: "record_count", type: "long" },
            { name: "file_size_in_bytes", type: "long" },
          ],
        },
      },
    ],
  };
}

function avroDataManifestEntry(
  file: {
    path: string;
    sequenceNumber: number;
    partition: Record<string, string>;
    recordCount: number;
    fileSizeInBytes: number;
  },
  snapshotId: number,
): Record<string, unknown> {
  return {
    status: 1,
    snapshot_id: BigInt(snapshotId),
    sequence_number: BigInt(file.sequenceNumber),
    file_sequence_number: BigInt(file.sequenceNumber),
    data_file: {
      content: 0,
      file_path: file.path,
      file_format: "PARQUET",
      partition: file.partition,
      record_count: BigInt(file.recordCount),
      file_size_in_bytes: BigInt(file.fileSizeInBytes),
      equality_ids: null,
    },
  };
}

function avroV1DataManifestEntry(
  file: {
    path: string;
    partition: Record<string, string>;
    recordCount: number;
    fileSizeInBytes: number;
  },
  snapshotId: number,
): Record<string, unknown> {
  return {
    status: 1,
    snapshot_id: BigInt(snapshotId),
    data_file: {
      file_path: file.path,
      file_format: "PARQUET",
      partition: file.partition,
      record_count: BigInt(file.recordCount),
      file_size_in_bytes: BigInt(file.fileSizeInBytes),
    },
  };
}

function avroDeleteManifestEntry(file: {
  path: string;
  content: 1 | 2;
  partition: Record<string, string>;
  recordCount: number;
  fileSizeInBytes: number;
  sequenceNumber: number;
}): Record<string, unknown> {
  return {
    status: 1,
    snapshot_id: 2n,
    sequence_number: BigInt(file.sequenceNumber),
    file_sequence_number: BigInt(file.sequenceNumber),
    data_file: {
      content: file.content,
      file_path: file.path,
      file_format: "PARQUET",
      partition: file.partition,
      record_count: BigInt(file.recordCount),
      file_size_in_bytes: BigInt(file.fileSizeInBytes),
      equality_ids: file.content === 2 ? [3] : null,
    },
  };
}

function avroV1ManifestListEntry(
  path: string,
  snapshotId: number,
  fileCount: number,
  rowCount: number,
): Record<string, unknown> {
  return {
    manifest_path: path,
    manifest_length: BigInt(fixtureSize(path)),
    partition_spec_id: 0,
    added_snapshot_id: BigInt(snapshotId),
    added_files_count: fileCount,
    existing_files_count: 0,
    deleted_files_count: 0,
    added_rows_count: BigInt(rowCount),
    existing_rows_count: 0n,
    deleted_rows_count: 0n,
    partitions: null,
  };
}

function avroManifestListEntry(
  path: string,
  content: 0 | 1,
  snapshotId: number,
  fileCount: number,
  rowCount: number,
): Record<string, unknown> {
  return {
    manifest_path: path,
    manifest_length: BigInt(fixtureSize(path)),
    partition_spec_id: 0,
    content,
    sequence_number: BigInt(snapshotId),
    min_sequence_number: 1n,
    added_snapshot_id: BigInt(snapshotId),
    added_files_count: fileCount,
    existing_files_count: 0,
    deleted_files_count: 0,
    added_rows_count: BigInt(rowCount),
    existing_rows_count: 0n,
    deleted_rows_count: 0n,
    partitions: null,
  };
}

async function writeAvroFixture(
  path: string,
  schema: unknown,
  records: Record<string, unknown>[],
): Promise<void> {
  const bytes = await avroObjectContainer(schema, records);
  const fullPath = fixturePath(path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, bytes);
}

async function avroObjectContainer(
  schema: unknown,
  records: Record<string, unknown>[],
): Promise<Uint8Array> {
  const type = avro.Type.forSchema(schema as avro.Schema, {
    typeHook: (innerSchema: unknown) =>
      innerSchema === "long" ||
      (typeof innerSchema === "object" &&
        innerSchema !== null &&
        !Array.isArray(innerSchema) &&
        "type" in innerSchema &&
        innerSchema.type === "long")
        ? avroBigIntLongType
        : undefined,
  });
  const encoder = new avro.streams.BlockEncoder(type, {
    codec: "null",
    syncMarker: Buffer.from("lakeql-iceberg-avr", "utf8"),
  });
  const chunks: Uint8Array[] = [];
  encoder.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    encoder.on("end", resolve);
    encoder.on("error", reject);
  });
  for (const record of records) encoder.write(record);
  encoder.end();
  await done;
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const avroBigIntLongType = avro.types.LongType.__with({
  fromBuffer: (bytes: Buffer) => bytes.readBigInt64LE(),
  toBuffer: (value: bigint | number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64LE(BigInt(value));
    return bytes;
  },
  fromJSON: (value: string | number | bigint) => BigInt(value),
  toJSON: (value: bigint | number) => value.toString(),
  isValid: (value: unknown) =>
    typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value)),
  compare: (left: bigint | number, right: bigint | number) => {
    const leftBigInt = BigInt(left);
    const rightBigInt = BigInt(right);
    return leftBigInt === rightBigInt ? 0 : leftBigInt < rightBigInt ? -1 : 1;
  },
});

function generateIcebergDeletes() {
  const equalityPath = fixturePath(ICEBERG.equalityDeleteFile);
  mkdirSync(dirname(equalityPath), { recursive: true });
  parquetWriteFile({
    filename: equalityPath,
    columnData: [{ name: "country", data: ["CA"], type: "STRING" }],
  });

  const positionPath = fixturePath(ICEBERG.positionDeleteFile);
  mkdirSync(dirname(positionPath), { recursive: true });
  parquetWriteFile({
    filename: positionPath,
    columnData: [
      { name: "file_path", data: [ICEBERG.dataFiles[0]], type: "STRING" },
      { name: "pos", data: [1n], type: "INT64" },
    ],
  });
}

generateSales();
generateTypes();
generateWide();
generateStats();
generateGroupby();
generateGeo();
generateH3();
generateWriteGolden();
generateManifestGoldens();
generateHive();
generateIcebergDeletes();
await generateIceberg();
console.log(`fixtures written to ${fixtureDataDir}`);

function writeJsonFixture(name: string, value: unknown) {
  const path = fixturePath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableStringify(value)}\n`);
}

function normalizeTaskInput(task: {
  path: string;
  etag?: string;
  size?: number;
  rowGroupRanges: { start: number; end: number }[];
  projectedColumns?: string[];
  partitionValues: Record<string, string>;
  residualPredicate?: unknown;
}) {
  const normalized = {
    path: task.path,
    etag: task.etag,
    size: task.size,
    rowGroupRanges: [...task.rowGroupRanges]
      .map((range) => ({ start: range.start, end: range.end }))
      .sort((a, b) => a.start - b.start || a.end - b.end),
    projectedColumns: task.projectedColumns ? [...task.projectedColumns].sort() : undefined,
    partitionValues: sortRecord(task.partitionValues),
  };
  if (task.residualPredicate !== undefined) {
    return { ...normalized, residualPredicate: task.residualPredicate };
  }
  return normalized;
}

function normalizeOutputEntry(entry: {
  taskId: string;
  outputPath: string;
  partitionValues: Record<string, string>;
  rowCount: number;
  byteSize: number;
  contentHash?: string;
  etag?: string;
  iceberg?: {
    recordCount: number;
    fileSizeInBytes: number;
    partitionValues: Record<string, string>;
  };
}) {
  return {
    taskId: entry.taskId,
    outputPath: entry.outputPath,
    partitionValues: sortRecord(entry.partitionValues),
    rowCount: entry.rowCount,
    byteSize: entry.byteSize,
    contentHash: entry.contentHash,
    etag: entry.etag,
    iceberg: entry.iceberg
      ? {
          recordCount: entry.iceberg.recordCount,
          fileSizeInBytes: entry.iceberg.fileSizeInBytes,
          partitionValues: sortRecord(entry.iceberg.partitionValues),
        }
      : undefined,
  };
}

function taskId(jobId: string, index: number, task: unknown): string {
  return `${jobId}-task-${String(index).padStart(6, "0")}-${fingerprint(task).slice(3, 11)}`;
}

function fingerprint(value: unknown): string {
  return `fp_${fnv1a64(stableStringify(value)).toString(16).padStart(16, "0")}`;
}

function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const char of input) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJson(value));
}

function toStableJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return base64UrlEncode(value);
  if (Array.isArray(value)) return value.map(toStableJson);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
      if (inner !== undefined) out[key] = toStableJson(inner);
    }
    return out;
  }
  return String(value);
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
