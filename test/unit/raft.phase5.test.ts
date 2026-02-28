import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInMemoryRaftNetwork,
  diskeyval,
  type SetCommand
} from '../../lib/index.ts';
import { forceLeader, waitForCondition } from '../support/helpers.ts';

test('[unit/phase5] persists committed state across node restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'diskeyval-persist-'));
  const network = createInMemoryRaftNetwork<SetCommand>();

  const createNode = () =>
    diskeyval({
      nodeId: 'node-1',
      peers: [],
      transport: network,
      persistence: {
        dir: dataDir,
        compactEvery: 2
      },
      electionTimeoutMs: 10_000,
      heartbeatMs: 20,
      proposalTimeoutMs: 400
    });

  const firstNode = createNode();

  try {
    await firstNode.start();
    await forceLeader(firstNode);

    await firstNode.set('persisted-key', 'persisted-value');
    await firstNode.end();

    const restartedNode = createNode();
    await restartedNode.start();

    try {
      assert.equal(restartedNode.state['persisted-key'], 'persisted-value');

      await forceLeader(restartedNode);
      const value = await restartedNode.get('persisted-key');
      assert.equal(value, 'persisted-value');
    } finally {
      await restartedNode.end();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('[unit/phase5] exposes raft metrics and increments critical counters', async () => {
  const network = createInMemoryRaftNetwork<SetCommand>();
  const node = diskeyval({
    nodeId: 'metrics-node',
    peers: [],
    transport: network,
    electionTimeoutMs: 10_000,
    heartbeatMs: 20,
    proposalTimeoutMs: 400
  });

  await node.start();

  try {
    await forceLeader(node);
    await node.set('m1', 1);
    await node.get('m1');

    await waitForCondition(() => node.getMetrics().commitsApplied > 0, {
      timeoutMs: 500,
      message: 'Expected commit metrics to increment'
    });

    const metrics = node.getMetrics();
    assert.ok(metrics.electionsStarted >= 1);
    assert.ok(metrics.leadershipsWon >= 1);
    assert.ok(metrics.proposalsReceived >= 1);
    assert.ok(metrics.proposalsCommitted >= 1);
    assert.ok(metrics.readBarriersRequested >= 1);
    assert.ok(metrics.commitsApplied >= 1);
  } finally {
    await node.end();
  }
});
