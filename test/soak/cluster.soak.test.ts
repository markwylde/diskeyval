import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestCluster, forceLeader, waitForCondition } from '../support/helpers.ts';

test('high write throughput burst converges on all replicas', async () => {
  const cluster = createTestCluster(['node-1', 'node-2', 'node-3', 'node-4', 'node-5']);
  await cluster.start();

  try {
    await forceLeader(cluster.nodes['node-1']);

    const writeCount = 120;
    for (let index = 0; index < writeCount; index += 1) {
      await cluster.nodes['node-1'].set(`k-${index}`, index);
    }

    await waitForCondition(
      () => cluster.nodes['node-4'].state['k-119'] === 119,
      {
        timeoutMs: 2_000,
        intervalMs: 15,
        message: 'Tail write did not replicate in throughput burst'
      }
    );

    assert.equal(cluster.nodes['node-1'].state['k-0'], 0);
    assert.equal(cluster.nodes['node-2'].state['k-50'], 50);
    assert.equal(cluster.nodes['node-3'].state['k-119'], 119);
  } finally {
    await cluster.stop();
  }
});

test('cluster recovers from repeated partition/heal cycles', async () => {
  const cluster = createTestCluster();
  await cluster.start();

  try {
    await forceLeader(cluster.nodes['node-1']);

    for (let cycle = 0; cycle < 8; cycle += 1) {
      cluster.network.partition('node-1', 'node-3');
      cluster.network.partition('node-2', 'node-3');
      await cluster.nodes['node-1'].set(`cycle-${cycle}`, cycle);
      cluster.network.healAll();

      await waitForCondition(
        () => cluster.nodes['node-3'].state[`cycle-${cycle}`] === cycle,
        {
          timeoutMs: 1_500,
          intervalMs: 20,
          message: `Lagging follower did not catch up after cycle ${cycle}`
        }
      );
    }
  } finally {
    await cluster.stop();
  }
});

test('randomized partition churn preserves convergence safety', async () => {
  const cluster = createTestCluster();
  await cluster.start();

  try {
    await forceLeader(cluster.nodes['node-1']);

    for (let index = 0; index < 50; index += 1) {
      if (index % 7 === 0) {
        cluster.network.partition('node-1', 'node-3');
        cluster.network.partition('node-2', 'node-3');
      }
      if (index % 7 === 3) {
        cluster.network.healAll();
      }

      await cluster.nodes['node-1'].set(`safe-${index}`, index);
    }

    cluster.network.healAll();

    await waitForCondition(
      () => cluster.nodes['node-3'].state['safe-49'] === 49,
      {
        timeoutMs: 2_000,
        intervalMs: 20,
        message: 'Cluster failed to converge after randomized churn'
      }
    );

    assert.equal(cluster.nodes['node-1'].state['safe-49'], 49);
    assert.equal(cluster.nodes['node-2'].state['safe-49'], 49);
    assert.equal(cluster.nodes['node-3'].state['safe-49'], 49);
  } finally {
    await cluster.stop();
  }
});
