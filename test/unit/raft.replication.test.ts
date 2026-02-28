import assert from 'node:assert/strict';
import test from 'node:test';
import { isQuorumUnavailableError } from '../../lib/index.ts';
import { createTestCluster, forceLeader, waitForCondition } from '../support/helpers.ts';

test('[unit/replication] leader appends new entry to local log', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    const raft = cluster.nodes['node-1'].getRaftNode();
    const before = raft.getState().lastLogIndex;

    await cluster.nodes['node-1'].set('alpha', 1);

    const after = raft.getState().lastLogIndex;
    assert.equal(after, before + 1);
  } finally {
    await cluster.stop();
  }
});

test('[unit/replication] leader replicates entry to followers', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    await cluster.nodes['node-1'].set('shared', 'value');

    await waitForCondition(
      () => cluster.nodes['node-2'].state.shared === 'value' && cluster.nodes['node-3'].state.shared === 'value',
      { timeoutMs: 700, message: 'Followers did not apply replicated value' }
    );
  } finally {
    await cluster.stop();
  }
});

test('[unit/replication] commit index advances after majority acks', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    const raft = cluster.nodes['node-1'].getRaftNode();
    const before = raft.getState().commitIndex;

    await cluster.nodes['node-1'].set('k', 'v');

    const after = raft.getState().commitIndex;
    assert.ok(after > before);
  } finally {
    await cluster.stop();
  }
});

test('[unit/replication] cluster does not commit with minority replication', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    cluster.network.partition('node-1', 'node-2');
    cluster.network.partition('node-1', 'node-3');

    await assert.rejects(
      () => cluster.nodes['node-1'].set('uncommitted', true),
      (error: unknown) => isQuorumUnavailableError(error)
    );
    assert.equal(cluster.nodes['node-1'].state.uncommitted, undefined);
    assert.equal(cluster.nodes['node-2'].state.uncommitted, undefined);
    assert.equal(cluster.nodes['node-3'].state.uncommitted, undefined);
  } finally {
    await cluster.stop();
  }
});

test('[unit/replication] write proposal promise resolves only on commit', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    const pendingSet = cluster.nodes['node-1'].set('ready', 'now');
    await pendingSet;

    assert.equal(cluster.nodes['node-1'].state.ready, 'now');
  } finally {
    await cluster.stop();
  }
});

test('[unit/replication] write proposal promise rejects on leadership loss', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);

    cluster.network.partition('node-1', 'node-2');
    cluster.network.partition('node-1', 'node-3');

    await assert.rejects(
      () => cluster.nodes['node-1'].set('x', 'y'),
      /quorum|majority|Timed out/i
    );
  } finally {
    await cluster.stop();
  }
});
