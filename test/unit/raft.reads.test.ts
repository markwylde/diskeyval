import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotLeaderError, isQuorumUnavailableError } from '../../lib/index.ts';
import { createTestCluster, forceLeader } from '../support/helpers.ts';

test('[unit/reads] leader read barrier succeeds with quorum heartbeat', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    await cluster.nodes['node-1'].set('item', 'value');

    const value = await cluster.nodes['node-1'].get('item');
    assert.equal(value, 'value');
  } finally {
    await cluster.stop();
  }
});

test('[unit/reads] leader read barrier rejects when quorum unavailable', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    cluster.network.partition('node-1', 'node-2');
    cluster.network.partition('node-1', 'node-3');

    await assert.rejects(
      () => cluster.nodes['node-1'].get('item'),
      (error: unknown) => isQuorumUnavailableError(error)
    );
  } finally {
    await cluster.stop();
  }
});

test('[unit/reads] follower read redirects to known leader', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);

    await assert.rejects(
      () => cluster.nodes['node-2'].get('item'),
      (error: unknown) => {
        assert.ok(isNotLeaderError(error));
        assert.equal(error.leaderId, 'node-1');
        return true;
      }
    );
  } finally {
    await cluster.stop();
  }
});

test('[unit/reads] read after committed write sees new value', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    await cluster.nodes['node-1'].set('after-write', 42);

    const value = await cluster.nodes['node-1'].get<number>('after-write');
    assert.equal(value, 42);
  } finally {
    await cluster.stop();
  }
});

test('[unit/reads] read does not observe uncommitted value', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    cluster.network.partition('node-1', 'node-2');
    cluster.network.partition('node-1', 'node-3');

    await assert.rejects(() => cluster.nodes['node-1'].set('unsafe', 'value'));
    await assert.rejects(() => cluster.nodes['node-1'].get('unsafe'));
  } finally {
    await cluster.stop();
  }
});

test('[unit/reads] read returns undefined for missing key', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);

    const value = await cluster.nodes['node-1'].get('missing');
    assert.equal(value, undefined);
  } finally {
    await cluster.stop();
  }
});
