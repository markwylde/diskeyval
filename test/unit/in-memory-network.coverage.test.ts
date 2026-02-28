import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryRaftNetwork } from '../../lib/raft/in-memory-network.ts';
import type { RaftRpcEndpoint } from '../../lib/raft/types.ts';

type Command = { value: string };

function endpoint(): RaftRpcEndpoint<Command> {
  return {
    onRequestVote: async (_from, request) => ({
      term: request.term,
      voteGranted: true
    }),
    onAppendEntries: async (_from, request) => ({
      term: request.term,
      success: true,
      matchIndex: request.prevLogIndex + request.entries.length
    })
  };
}

test('[unit/in-memory-network] supports latency and basic rpc', async () => {
  const network = createInMemoryRaftNetwork<Command>({ latencyMs: 1 });
  network.register('node-2', endpoint());

  const vote = await network.requestVote('node-1', 'node-2', {
    term: 1,
    candidateId: 'node-1',
    lastLogIndex: 0,
    lastLogTerm: 0
  });
  assert.equal(vote.voteGranted, true);

  const append = await network.appendEntries('node-1', 'node-2', {
    term: 1,
    leaderId: 'node-1',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [],
    leaderCommit: 0
  });
  assert.equal(append.success, true);
});

test('[unit/in-memory-network] unknown nodes and heal path are covered', async () => {
  const network = createInMemoryRaftNetwork<Command>();

  await assert.rejects(
    () =>
      network.requestVote('node-1', 'missing', {
        term: 1,
        candidateId: 'node-1',
        lastLogIndex: 0,
        lastLogTerm: 0
      }),
    /Unknown node: missing/i
  );

  network.register('node-2', endpoint());
  network.partition('node-1', 'node-2');
  await assert.rejects(
    () =>
      network.appendEntries('node-1', 'node-2', {
        term: 1,
        leaderId: 'node-1',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0
      }),
    /Network partition/i
  );

  network.heal('node-1', 'node-2');
  const healed = await network.appendEntries('node-1', 'node-2', {
    term: 1,
    leaderId: 'node-1',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [],
    leaderCommit: 0
  });
  assert.equal(healed.success, true);

  network.partition('node-1', 'node-2');
  network.healAll();
  const healedAll = await network.appendEntries('node-1', 'node-2', {
    term: 1,
    leaderId: 'node-1',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [],
    leaderCommit: 0
  });
  assert.equal(healedAll.success, true);

  network.unregister('node-2');
  await assert.rejects(
    () =>
      network.appendEntries('node-1', 'node-2', {
        term: 1,
        leaderId: 'node-1',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0
      }),
    /Unknown node: node-2/i
  );
});

