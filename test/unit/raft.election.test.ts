import assert from 'node:assert/strict';
import test from 'node:test';
import { isNotLeaderError } from '../../lib/index.ts';
import { createTestCluster, forceLeader, sleep } from '../support/helpers.ts';

test('[unit/election] elects one leader in stable 3-node cluster', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);

    assert.equal(cluster.nodes['node-1'].isLeader(), true);
    assert.equal(cluster.nodes['node-2'].isLeader(), false);
    assert.equal(cluster.nodes['node-3'].isLeader(), false);

    assert.equal(cluster.nodes['node-2'].leaderId(), 'node-1');
    assert.equal(cluster.nodes['node-3'].leaderId(), 'node-1');
  } finally {
    await cluster.stop();
  }
});

test('[unit/election] does not elect two leaders in same term', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    const originalLeaderTerm = cluster.nodes['node-1'].getRaftNode().getState().currentTerm;
    await cluster.nodes['node-2'].forceElection();
    await sleep(40);

    const leaderCount = Object.values(cluster.nodes).filter((node) => node.isLeader()).length;
    assert.equal(leaderCount, 1);

    const leadersByTerm = new Map<number, number>();
    for (const node of Object.values(cluster.nodes)) {
      const state = node.getRaftNode().getState();
      if (!node.isLeader()) {
        continue;
      }
      leadersByTerm.set(state.currentTerm, (leadersByTerm.get(state.currentTerm) ?? 0) + 1);
    }

    for (const [, count] of leadersByTerm.entries()) {
      assert.equal(count, 1);
    }
    assert.ok(cluster.nodes['node-1'].getRaftNode().getState().currentTerm >= originalLeaderTerm);
  } finally {
    await cluster.stop();
  }
});

test('[unit/election] follower rejects vote for stale term', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    const follower = cluster.nodes['node-2'].getRaftNode();

    const vote = await follower.onRequestVote('node-3', {
      term: 0,
      candidateId: 'node-3',
      lastLogIndex: 0,
      lastLogTerm: 0
    });

    assert.equal(vote.voteGranted, false);
    assert.ok(vote.term >= 1);
  } finally {
    await cluster.stop();
  }
});

test('[unit/election] leader steps down when receiving higher term append', async () => {
  const cluster = createTestCluster();
  await cluster.start();
  try {
    await forceLeader(cluster.nodes['node-1']);
    const leaderRaft = cluster.nodes['node-1'].getRaftNode();

    const response = await leaderRaft.onAppendEntries('node-2', {
      term: leaderRaft.getState().currentTerm + 1,
      leaderId: 'node-2',
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [],
      leaderCommit: leaderRaft.getState().commitIndex
    });

    assert.equal(response.success, true);
    assert.equal(cluster.nodes['node-1'].isLeader(), false);
    assert.equal(cluster.nodes['node-1'].leaderId(), 'node-2');

    await assert.rejects(
      () => cluster.nodes['node-1'].set('k', 'v'),
      (error: unknown) => isNotLeaderError(error)
    );
  } finally {
    await cluster.stop();
  }
});
