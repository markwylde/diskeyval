import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import diskeyval, { type DiskeyvalNode } from '../../lib/index.ts';
import { isNotLeaderError, isQuorumUnavailableError } from '../../lib/index.ts';
import { hasOpenSsl } from '../support/certs.ts';
import { createTestCertificates } from '../support/certs.ts';
import { getFreePorts } from '../support/ports.ts';
import { createTlsTestCluster } from '../support/tls-cluster.ts';
import { waitForCondition } from '../support/helpers.ts';

async function forceLeader(node: { forceElection: () => Promise<void>; isLeader: () => boolean }) {
  await node.forceElection();
  await waitForCondition(() => node.isLeader(), {
    timeoutMs: 1_500,
    intervalMs: 20,
    message: 'Expected forced node to become leader'
  });
}

test('mTLS cluster elects leader and replicates writes', { skip: !hasOpenSsl() }, async () => {
  const cluster = await createTlsTestCluster(['node-1', 'node-2', 'node-3']);

  try {
    await cluster.start();
    await forceLeader(cluster.nodes['node-1']);

    await cluster.nodes['node-1'].set('e2e-key', 'e2e-value');

    await waitForCondition(
      () =>
        cluster.nodes['node-1'].state['e2e-key'] === 'e2e-value' &&
        cluster.nodes['node-2'].state['e2e-key'] === 'e2e-value' &&
        cluster.nodes['node-3'].state['e2e-key'] === 'e2e-value',
      {
        timeoutMs: 3_000,
        intervalMs: 25,
        message: 'mTLS cluster did not converge on committed value'
      }
    );
  } finally {
    await cluster.stop();
    cluster.cleanup();
  }
});

test('mTLS cluster rejects writes when quorum is unavailable', { skip: !hasOpenSsl() }, async () => {
  const cluster = await createTlsTestCluster(['node-1', 'node-2', 'node-3']);

  try {
    await cluster.start();
    await forceLeader(cluster.nodes['node-1']);

    await cluster.nodes['node-2'].end();
    await cluster.nodes['node-3'].end();

    await assert.rejects(
      () => cluster.nodes['node-1'].set('blocked-write', true),
      (error: unknown) => isQuorumUnavailableError(error)
    );
  } finally {
    await cluster.stop();
    cluster.cleanup();
  }
});

test('mTLS cluster performs failover when leader stops', { skip: !hasOpenSsl() }, async () => {
  const cluster = await createTlsTestCluster(['node-1', 'node-2', 'node-3']);

  try {
    await cluster.start();
    await forceLeader(cluster.nodes['node-1']);

    await cluster.nodes['node-1'].end();

    await waitForCondition(
      () => cluster.nodes['node-2'].isLeader() || cluster.nodes['node-3'].isLeader(),
      {
        timeoutMs: 4_000,
        intervalMs: 25,
        message: 'No new leader elected after stopping previous leader'
      }
    );

    const newLeader = cluster.nodes['node-2'].isLeader() ? cluster.nodes['node-2'] : cluster.nodes['node-3'];
    await newLeader.set('post-failover', 'ok');

    await waitForCondition(
      () => cluster.nodes['node-2'].state['post-failover'] === 'ok' || cluster.nodes['node-3'].state['post-failover'] === 'ok',
      {
        timeoutMs: 3_000,
        intervalMs: 25,
        message: 'New leader did not replicate post-failover write'
      }
    );
  } finally {
    await cluster.stop();
    cluster.cleanup();
  }
});

test('follower mTLS read returns not-leader error with leader hint', { skip: !hasOpenSsl() }, async () => {
  const cluster = await createTlsTestCluster(['node-1', 'node-2', 'node-3']);

  try {
    await cluster.start();
    await forceLeader(cluster.nodes['node-1']);
    await waitForCondition(() => cluster.nodes['node-2'].leaderId() === 'node-1', {
      timeoutMs: 1_500,
      intervalMs: 20,
      message: 'Follower did not observe leader identity'
    });

    await assert.rejects(
      () => cluster.nodes['node-2'].get('missing'),
      (error: unknown) => {
        assert.ok(isNotLeaderError(error));
        assert.equal(error.leaderId, 'node-1');
        return true;
      }
    );
  } finally {
    await cluster.stop();
    cluster.cleanup();
  }
});

test('mTLS cluster restores committed state after full restart', { skip: !hasOpenSsl() }, async () => {
  const persistenceDir = await mkdtemp(join(tmpdir(), 'diskeyval-e2e-persist-'));

  const firstRun = await createTlsTestCluster(['node-1', 'node-2', 'node-3'], {
    persistenceDir
  });
  let committedWriterId: 'node-1' | 'node-2' | 'node-3' = 'node-1';

  const getLeader = (nodes: typeof firstRun.nodes) => {
    if (nodes['node-1'].isLeader()) {
      return nodes['node-1'];
    }
    if (nodes['node-2'].isLeader()) {
      return nodes['node-2'];
    }
    if (nodes['node-3'].isLeader()) {
      return nodes['node-3'];
    }
    return null;
  };

  try {
    await firstRun.start();
    await waitForCondition(() => getLeader(firstRun.nodes) !== null, {
      timeoutMs: 3_000,
      intervalMs: 20,
      message: 'Expected a leader before initial persistent write'
    });

    const initialLeader = getLeader(firstRun.nodes);
    assert.ok(initialLeader);
    await initialLeader.set('restart-key', 'restart-value');
    committedWriterId = initialLeader.nodeId as 'node-1' | 'node-2' | 'node-3';
  } finally {
    await firstRun.stop();
    firstRun.cleanup();
  }

  const secondRun = await createTlsTestCluster(['node-1', 'node-2', 'node-3'], {
    persistenceDir
  });

  try {
    await secondRun.start();
    await waitForCondition(
      () => secondRun.nodes[committedWriterId].state['restart-key'] === 'restart-value',
      {
        timeoutMs: 8_000,
        intervalMs: 25,
        message: 'Expected persisted state to be restored on restart for committed writer'
      }
    );

    await forceLeader(secondRun.nodes[committedWriterId]);
    const recovered = await secondRun.nodes[committedWriterId].get('restart-key');
    assert.equal(recovered, 'restart-value');
  } finally {
    await secondRun.stop();
    secondRun.cleanup();
    await rm(persistenceDir, { recursive: true, force: true });
  }
});

test('mTLS cluster can dynamically add a new node and replicate state', { skip: !hasOpenSsl() }, async () => {
  const nodeIds = ['node-1', 'node-2', 'node-3', 'node-4'];
  const certs = createTestCertificates(nodeIds);
  const ports = await getFreePorts(nodeIds.length);
  const endpoints = Object.fromEntries(
    nodeIds.map((nodeId, index) => [
      nodeId,
      {
        nodeId,
        host: '127.0.0.1',
        port: ports[index]
      }
    ])
  ) as Record<string, { nodeId: string; host: string; port: number }>;

  const mkNode = (nodeId: string, peers: string[]): DiskeyvalNode =>
    diskeyval({
      nodeId,
      host: endpoints[nodeId].host,
      port: endpoints[nodeId].port,
      peers: peers.map((peerId) => ({
        nodeId: endpoints[peerId].nodeId,
        host: endpoints[peerId].host,
        port: endpoints[peerId].port
      })),
      tls: {
        cert: certs.nodes[nodeId].certPem,
        key: certs.nodes[nodeId].keyPem,
        ca: certs.caPem
      },
      electionTimeoutMs: 200,
      heartbeatMs: 50,
      proposalTimeoutMs: 2_000,
      rpcTimeoutMs: 2_000
    });

  const node1 = mkNode('node-1', ['node-2', 'node-3']);
  const node2 = mkNode('node-2', ['node-1', 'node-3']);
  const node3 = mkNode('node-3', ['node-1', 'node-2']);
  const node4 = mkNode('node-4', ['node-2']);

  try {
    await node1.start();
    await node2.start();
    await node3.start();

    await forceLeader(node1);
    await node1.set('before-join', 'present');

    await node4.start();

    await node1.reconfigure([
      endpoints['node-2'],
      endpoints['node-3'],
      endpoints['node-4']
    ]);

    await waitForCondition(
      () => node4.state['before-join'] === 'present',
      {
        timeoutMs: 5_000,
        intervalMs: 30,
        message: 'new node did not catch up existing committed state after reconfigure'
      }
    );

    await node1.set('after-join', 'replicated');
    await waitForCondition(
      () =>
        node2.state['after-join'] === 'replicated' &&
        node3.state['after-join'] === 'replicated' &&
        node4.state['after-join'] === 'replicated',
      {
        timeoutMs: 5_000,
        intervalMs: 30,
        message: 'new cluster membership did not replicate subsequent writes'
      }
    );
  } finally {
    await Promise.all([
      node1.end().catch(() => undefined),
      node2.end().catch(() => undefined),
      node3.end().catch(() => undefined),
      node4.end().catch(() => undefined)
    ]);
    certs.cleanup();
  }
});
