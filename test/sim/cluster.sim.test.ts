import assert from 'node:assert/strict';
import test from 'node:test';
import { isQuorumUnavailableError } from '../../lib/index.ts';
import { createTestCluster, forceLeader, waitForCondition } from '../support/helpers.ts';

test('[sim] 3-node cluster elects leader and commits value', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    await cluster.nodes['node-1'].set('sim-key', 'sim-value');

    await waitForCondition(
      () =>
        cluster.nodes['node-1'].state['sim-key'] === 'sim-value' &&
        cluster.nodes['node-2'].state['sim-key'] === 'sim-value' &&
        cluster.nodes['node-3'].state['sim-key'] === 'sim-value',
      { timeoutMs: 1_000, message: 'Cluster did not converge' }
    );
  } finally {
    await cluster.stop();
  }
});

test('[sim] minority partition cannot commit', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    cluster.network.partition('node-1', 'node-2');
    cluster.network.partition('node-1', 'node-3');

    await assert.rejects(
      () => cluster.nodes['node-1'].set('blocked', 1),
      (error: unknown) => isQuorumUnavailableError(error)
    );
  } finally {
    await cluster.stop();
  }
});

test('[sim] majority partition continues committing', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);

    cluster.network.partition('node-1', 'node-3');
    cluster.network.partition('node-2', 'node-3');

    await cluster.nodes['node-1'].set('majority', true);
    await waitForCondition(
      () => cluster.nodes['node-2'].state.majority === true,
      { timeoutMs: 500, message: 'Majority peer did not commit write' }
    );

    assert.equal(cluster.nodes['node-3'].state.majority, undefined);
  } finally {
    await cluster.stop();
  }
});

test('[sim] partition heal converges logs', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);

    cluster.network.partition('node-1', 'node-3');
    cluster.network.partition('node-2', 'node-3');
    await cluster.nodes['node-1'].set('heal-key', 'during-partition');

    cluster.network.healAll();

    await waitForCondition(
      () => cluster.nodes['node-3'].state['heal-key'] === 'during-partition',
      { timeoutMs: 1_200, message: 'Lagging node did not catch up after heal' }
    );
  } finally {
    await cluster.stop();
  }
});

test('[sim] dynamic reconfigure can add a new node and replicate state', async () => {
  const cluster = createTestCluster(['node-1', 'node-2', 'node-3', 'node-4']);
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);

    await cluster.nodes['node-1'].reconfigure([
      { nodeId: 'node-2' },
      { nodeId: 'node-3' },
      { nodeId: 'node-4' }
    ]);

    await cluster.nodes['node-1'].set('new-member-key', 'replicated');

    await waitForCondition(
      () => cluster.nodes['node-4'].state['new-member-key'] === 'replicated',
      { timeoutMs: 1_500, message: 'new member did not catch up after reconfigure' }
    );
  } finally {
    await cluster.stop();
  }
});
