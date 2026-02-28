import assert from 'node:assert/strict';
import { createInMemoryDiskeyvalCluster, type DiskeyvalNode } from '../../lib/index.ts';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCondition(
  condition: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number; message?: string }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const intervalMs = options?.intervalMs ?? 10;
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    if (condition()) {
      return;
    }
    await sleep(intervalMs);
  }

  assert.fail(options?.message ?? `Condition not met within ${timeoutMs}ms`);
}

export async function forceLeader(node: DiskeyvalNode): Promise<void> {
  await node.forceElection();
  await waitForCondition(() => node.isLeader(), {
    timeoutMs: 500,
    message: `Node ${node.nodeId} did not become leader`
  });
}

export function createTestCluster(nodeIds: string[] = ['node-1', 'node-2', 'node-3']) {
  return createInMemoryDiskeyvalCluster(nodeIds, {
    electionTimeoutMs: 10_000,
    heartbeatMs: 20,
    proposalTimeoutMs: 200
  });
}

export function createTestClusterWithOptions(
  nodeIds: string[],
  options: {
    electionTimeoutMs?: number;
    heartbeatMs?: number;
    proposalTimeoutMs?: number;
  }
) {
  return createInMemoryDiskeyvalCluster(nodeIds, options);
}
