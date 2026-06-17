import {
  type AggregateSpec,
  type CacheAdapter,
  finalizeVectorAggregateStates,
  jsonWorkUnitBoundary,
  materializeBatchRows,
  mergeVectorAggregateStates,
  type ObjectStore,
  type Row,
  restoreVectorAggregateStates,
  type TaskInput,
  type VectorAggregateStateSnapshots,
  type VectorAggregateStates,
} from "lakeql-core";
import { aggregateParquetTask } from "./aggregate-task.js";
import { scanParquetTaskColumnBatches } from "./task-scan.js";
import type { ParquetMetadata } from "./types.js";

export const TEST_DEPLOYMENTS = ["browser", "cloudflare-worker", "supabase-edge"] as const;

export type TestDeployment = (typeof TEST_DEPLOYMENTS)[number];

export interface DeploymentWorkUnit {
  deployment: TestDeployment;
  task: TaskInput;
  delayMs?: number;
}

export interface PortableScanPartial {
  deployment: TestDeployment;
  index: number;
  rowGroupRanges: TaskInput["rowGroupRanges"];
  rows: Row[];
}

export interface PortableAggregatePartial {
  deployment: TestDeployment;
  index: number;
  rowGroupRanges: TaskInput["rowGroupRanges"];
  partial: VectorAggregateStateSnapshots;
}

export type DeploymentTransport = (
  input: DeploymentWorkUnit,
  index: number,
) => Promise<PortableScanPartial>;

export type DeploymentAggregateTransport = (
  input: DeploymentWorkUnit,
  index: number,
) => Promise<PortableAggregatePartial>;

export function testDeploymentForIndex(index: number): TestDeployment {
  const deployment = TEST_DEPLOYMENTS[index % TEST_DEPLOYMENTS.length];
  if (deployment === undefined) {
    throw new Error(`No test deployment for index ${index}`);
  }
  return deployment;
}

export function sortedTestDeployments(deployments: readonly TestDeployment[]): TestDeployment[] {
  return [...deployments].sort((left, right) => left.localeCompare(right));
}

export function asTestDeployment(value: unknown): TestDeployment {
  for (const deployment of TEST_DEPLOYMENTS) {
    if (value === deployment) return deployment;
  }
  throw new Error(`Unexpected test deployment: ${String(value)}`);
}

export function deploymentWorkUnitInputs(workUnits: readonly TaskInput[]): DeploymentWorkUnit[] {
  return workUnits.map((workUnit, index) => ({
    deployment: testDeploymentForIndex(index),
    task: workUnit,
  }));
}

export function portableScanTransports(
  store: ObjectStore,
  options: { batchSize?: number; metadataCache?: CacheAdapter<ParquetMetadata> } = {},
): Record<TestDeployment, DeploymentTransport> {
  return {
    async browser(input, index) {
      const message = jsonWorkUnitBoundary({ input, index });
      return scanPortableWorkUnit(store, message.input, message.index, options);
    },
    async "cloudflare-worker"(input, index) {
      const request = new Request("https://worker.local/lakeql/work-unit", {
        method: "POST",
        body: JSON.stringify({ input, index }),
      });
      const envelope = (await request.json()) as { input: DeploymentWorkUnit; index: number };
      return scanPortableWorkUnit(store, envelope.input, envelope.index, options);
    },
    async "supabase-edge"(input, index) {
      const invocation = jsonWorkUnitBoundary({ data: { input, index } });
      return scanPortableWorkUnit(store, invocation.data.input, invocation.data.index, options);
    },
  };
}

export function portableAggregateTransports(
  store: ObjectStore,
  spec: AggregateSpec,
  options: { batchSize?: number; metadataCache?: CacheAdapter<ParquetMetadata> } = {},
): Record<TestDeployment, DeploymentAggregateTransport> {
  return {
    async browser(input, index) {
      const message = jsonWorkUnitBoundary({ input, index });
      return aggregatePortableWorkUnit(store, message.input, message.index, spec, options);
    },
    async "cloudflare-worker"(input, index) {
      const request = new Request("https://worker.local/lakeql/aggregate-work-unit", {
        method: "POST",
        body: JSON.stringify({ input, index }),
      });
      const envelope = (await request.json()) as { input: DeploymentWorkUnit; index: number };
      return aggregatePortableWorkUnit(store, envelope.input, envelope.index, spec, options);
    },
    async "supabase-edge"(input, index) {
      const invocation = jsonWorkUnitBoundary({ data: { input, index } });
      return aggregatePortableWorkUnit(
        store,
        invocation.data.input,
        invocation.data.index,
        spec,
        options,
      );
    },
  };
}

export function mergePortableAggregatePartial(
  accumulator: VectorAggregateStates,
  partial: PortableAggregatePartial,
): void {
  mergeVectorAggregateStates(accumulator, restoreVectorAggregateStates(partial.partial));
}

export function finalizePortableAggregate(
  accumulator: VectorAggregateStates,
): Record<string, unknown> {
  return finalizeVectorAggregateStates(accumulator);
}

export async function scanPortableWorkUnit(
  store: ObjectStore,
  input: DeploymentWorkUnit,
  index: number,
  options: { batchSize?: number; metadataCache?: CacheAdapter<ParquetMetadata> } = {},
): Promise<PortableScanPartial> {
  const portableInput = jsonWorkUnitBoundary(input);
  if (portableInput.delayMs !== undefined) await sleep(portableInput.delayMs);
  const rows: Row[] = [];
  const scanOptions: { batchSize?: number; metadataCache?: CacheAdapter<ParquetMetadata> } = {};
  if (options.batchSize !== undefined) scanOptions.batchSize = options.batchSize;
  if (options.metadataCache !== undefined) scanOptions.metadataCache = options.metadataCache;
  for await (const batch of scanParquetTaskColumnBatches(store, portableInput.task, scanOptions)) {
    rows.push(...materializeBatchRows(batch.batch));
  }
  return {
    deployment: portableInput.deployment,
    index,
    rowGroupRanges: portableInput.task.rowGroupRanges,
    rows,
  };
}

export async function aggregatePortableWorkUnit(
  store: ObjectStore,
  input: DeploymentWorkUnit,
  index: number,
  spec: AggregateSpec,
  options: { batchSize?: number; metadataCache?: CacheAdapter<ParquetMetadata> } = {},
): Promise<PortableAggregatePartial> {
  const portableInput = jsonWorkUnitBoundary(input);
  if (portableInput.delayMs !== undefined) await sleep(portableInput.delayMs);
  const aggregateOptions: { batchSize?: number; metadataCache?: CacheAdapter<ParquetMetadata> } =
    {};
  if (options.batchSize !== undefined) aggregateOptions.batchSize = options.batchSize;
  if (options.metadataCache !== undefined) aggregateOptions.metadataCache = options.metadataCache;
  return {
    deployment: portableInput.deployment,
    index,
    rowGroupRanges: portableInput.task.rowGroupRanges,
    partial: await aggregateParquetTask(store, portableInput.task, spec, aggregateOptions),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
