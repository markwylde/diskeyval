import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRaftNode,
  isNotLeaderError,
  type AppendEntriesRequest,
  type AppendEntriesResponse,
  type RaftLogEntry,
  type RaftStorage,
  type RequestVoteRequest,
  type RequestVoteResponse
} from '../../lib/raft/index.ts';

function createScriptedTransport(options?: {
  requestVote?: (
    fromNodeId: string,
    toNodeId: string,
    request: RequestVoteRequest
  ) => Promise<RequestVoteResponse>;
  appendEntries?: (
    fromNodeId: string,
    toNodeId: string,
    request: AppendEntriesRequest<string>
  ) => Promise<AppendEntriesResponse>;
}) {
  return {
    requestVote:
      options?.requestVote ??
      (async (_fromNodeId, _toNodeId, request) => ({
        term: request.term,
        voteGranted: true
      })),
    appendEntries:
      options?.appendEntries ??
      (async (_fromNodeId, _toNodeId, request) => ({
        term: request.term,
        success: true,
        matchIndex: request.prevLogIndex + request.entries.length
      }))
  };
}

test('[unit/raft-coverage] stopped node paths and startElection no-op before start', async () => {
  const raft = createRaftNode<string>({
    nodeId: 'node-a',
    peerIds: ['node-b'],
    transport: createScriptedTransport(),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });

  await raft.startElection();
  assert.equal(raft.getState().currentTerm, 0);

  await assert.rejects(
    () =>
      raft.onRequestVote('node-b', {
        term: 1,
        candidateId: 'node-b',
        lastLogIndex: 0,
        lastLogTerm: 0
      }),
    /is stopped/i
  );
  await assert.rejects(
    () =>
      raft.onAppendEntries('node-b', {
        term: 1,
        leaderId: 'node-b',
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0
      }),
    /is stopped/i
  );
});

test('[unit/raft-coverage] raft event bus on/off duplicate handler paths', async () => {
  const raft = createRaftNode<string>({
    nodeId: 'node-events',
    peerIds: [],
    transport: createScriptedTransport(),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });

  let leaderEvents = 0;
  const leaderHandler = (): void => {
    leaderEvents += 1;
  };

  raft.off('leader', leaderHandler);
  raft.on('leader', leaderHandler);
  raft.on('leader', leaderHandler);

  await raft.start();
  await raft.startElection();

  raft.off('leader', leaderHandler);
  raft.off('leader', leaderHandler);

  assert.ok(leaderEvents >= 1);
  await raft.stop();
});

test('[unit/raft-coverage] storage load failures and malformed logs are handled', async () => {
  const loadFailStorage: RaftStorage<string> = {
    load: async () => {
      throw new Error('load failure');
    },
    save: async () => undefined
  };

  const raftWithLoadFailure = createRaftNode<string>({
    nodeId: 'node-load-fail',
    peerIds: [],
    transport: createScriptedTransport(),
    storage: loadFailStorage,
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });
  await raftWithLoadFailure.start();
  assert.equal(raftWithLoadFailure.getMetrics().persistenceLoadFailures, 1);
  await raftWithLoadFailure.stop();

  const emptyLogStorage: RaftStorage<string> = {
    load: async () => ({
      currentTerm: 3,
      votedFor: null,
      log: [],
      commitIndex: 0
    }),
    save: async () => undefined
  };

  const raftWithEmptyLog = createRaftNode<string>({
    nodeId: 'node-empty-log',
    peerIds: [],
    transport: createScriptedTransport(),
    storage: emptyLogStorage,
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });
  await raftWithEmptyLog.start();
  assert.equal(raftWithEmptyLog.getState().lastLogIndex, 0);
  await raftWithEmptyLog.stop();

  const applied: RaftLogEntry<string>[] = [];
  const noSentinelStorage: RaftStorage<string> = {
    load: async () => ({
      currentTerm: 2,
      votedFor: null,
      log: [{ index: 1, term: 2, command: 'loaded' }],
      commitIndex: 1
    }),
    save: async () => undefined
  };

  const raftWithNoSentinel = createRaftNode<string>({
    nodeId: 'node-no-sentinel',
    peerIds: [],
    transport: createScriptedTransport(),
    storage: noSentinelStorage,
    applyCommand: (entry) => {
      applied.push(entry);
    },
    electionTimeoutMs: 10_000
  });
  await raftWithNoSentinel.start();
  assert.equal(raftWithNoSentinel.getState().lastLogIndex, 1);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].command, 'loaded');
  await raftWithNoSentinel.stop();
});

test('[unit/raft-coverage] start is idempotent and save failures increment metrics', async () => {
  const failingSaveStorage: RaftStorage<string> = {
    load: async () => null,
    save: async () => {
      throw new Error('save failed');
    }
  };

  const raft = createRaftNode<string>({
    nodeId: 'node-save-fail',
    peerIds: [],
    transport: createScriptedTransport(),
    storage: failingSaveStorage,
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });

  await raft.start();
  await raft.start();
  await raft.startElection();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const metrics = raft.getMetrics();
  assert.ok(metrics.persistenceSaveFailures >= 1);
  await raft.stop();
});

test('[unit/raft-coverage] election handles higher term responses and vote transport failures', async () => {
  const raft = createRaftNode<string>({
    nodeId: 'node-1',
    peerIds: ['node-2', 'node-3'],
    transport: createScriptedTransport({
      requestVote: async (_fromNodeId, toNodeId, request) => {
        if (toNodeId === 'node-2') {
          throw new Error('network down');
        }
        return {
          term: request.term + 1,
          voteGranted: false
        };
      }
    }),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });

  await raft.start();
  await raft.startElection();

  const state = raft.getState();
  assert.equal(state.role, 'follower');
  assert.ok(state.currentTerm >= 2);
  const metrics = raft.getMetrics();
  assert.ok(metrics.requestVoteFailed >= 1);
  await raft.stop();
});

test('[unit/raft-coverage] election handles non-granted votes and newer candidate logs', async () => {
  const raft = createRaftNode<string>({
    nodeId: 'node-1',
    peerIds: ['node-2'],
    transport: createScriptedTransport({
      requestVote: async (_fromNodeId, _toNodeId, request) => ({
        term: request.term,
        voteGranted: false
      })
    }),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });

  await raft.start();
  try {
    await raft.startElection();
    assert.equal(raft.isLeader(), false);

    const vote = await raft.onRequestVote('node-2', {
      term: raft.getState().currentTerm + 1,
      candidateId: 'node-2',
      lastLogIndex: 99,
      lastLogTerm: 99
    });
    assert.equal(vote.voteGranted, true);
  } finally {
    await raft.stop();
  }
});

test('[unit/raft-coverage] append entries stale term and log mismatch responses', async () => {
  const raft = createRaftNode<string>({
    nodeId: 'node-1',
    peerIds: [],
    transport: createScriptedTransport(),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });
  await raft.start();
  await raft.startElection();
  assert.equal(raft.isLeader(), true);

  const stale = await raft.onAppendEntries('node-x', {
    term: 0,
    leaderId: 'node-x',
    prevLogIndex: 0,
    prevLogTerm: 0,
    entries: [],
    leaderCommit: 0
  });
  assert.equal(stale.success, false);

  const mismatch = await raft.onAppendEntries('node-x', {
    term: raft.getState().currentTerm,
    leaderId: 'node-x',
    prevLogIndex: 5,
    prevLogTerm: 99,
    entries: [],
    leaderCommit: 0
  });
  assert.equal(mismatch.success, false);
  await raft.stop();
});

test('[unit/raft-coverage] readBarrier demotes leader on higher term response', async () => {
  let appendEntriesCalls = 0;
  const raft = createRaftNode<string>({
    nodeId: 'node-1',
    peerIds: ['node-2'],
    transport: createScriptedTransport({
      appendEntries: async (_fromNodeId, _toNodeId, request) => {
        appendEntriesCalls += 1;
        if (appendEntriesCalls <= 2) {
          return {
            term: request.term,
            success: true,
            matchIndex: request.prevLogIndex + request.entries.length
          };
        }

        return {
          term: request.term + 1,
          success: false,
          matchIndex: 0
        };
      }
    }),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000,
    proposalTimeoutMs: 500
  });

  await raft.start();
  try {
    await raft.startElection();
    assert.equal(raft.isLeader(), true);

    await assert.rejects(
      () => raft.readBarrier(),
      (error: unknown) => isNotLeaderError(error)
    );
  } finally {
    await raft.stop();
  }
});

test('[unit/raft-coverage] readBarrier callback exits when leadership changes mid-flight', async () => {
  let appendEntriesCalls = 0;
  const raft = createRaftNode<string>({
    nodeId: 'node-1',
    peerIds: ['node-2', 'node-3'],
    transport: createScriptedTransport({
      appendEntries: async (_fromNodeId, toNodeId, request) => {
        appendEntriesCalls += 1;
        if (appendEntriesCalls <= 2) {
          return {
            term: request.term,
            success: true,
            matchIndex: request.prevLogIndex + request.entries.length
          };
        }

        if (toNodeId === 'node-2') {
          return {
            term: request.term + 1,
            success: false,
            matchIndex: 0
          };
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          term: request.term,
          success: true,
          matchIndex: request.prevLogIndex + request.entries.length
        };
      }
    }),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });

  await raft.start();
  try {
    await raft.startElection();
    await assert.rejects(
      () => raft.readBarrier(),
      (error: unknown) => isNotLeaderError(error)
    );
  } finally {
    await raft.stop();
  }
});

test('[unit/raft-coverage] stop rejects pending proposal promises', async () => {
  const raft = createRaftNode<string>({
    nodeId: 'node-1',
    peerIds: ['node-2'],
    transport: createScriptedTransport({
      appendEntries: async (fromNodeId, toNodeId, request) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          term: request.term,
          success: false,
          matchIndex: 0
        };
      }
    }),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000,
    proposalTimeoutMs: 600
  });

  await raft.start();
  await raft.startElection();
  assert.equal(raft.isLeader(), true);

  const pending = raft.propose('blocked');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await raft.stop();

  await assert.rejects(
    () => pending,
    /Node stopped before proposal committed/i
  );
});

test('[unit/raft-coverage] propose fails when leadership changes before commit', async () => {
  let raft: ReturnType<typeof createRaftNode<string>> | null = null;
  let appendEntriesCalls = 0;
  const transport = createScriptedTransport({
    appendEntries: async (_fromNodeId, _toNodeId, request) => {
      appendEntriesCalls += 1;
      if (appendEntriesCalls <= 2) {
        return {
          term: request.term,
          success: true,
          matchIndex: request.prevLogIndex + request.entries.length
        };
      }

      if (raft) {
        await raft.onAppendEntries('node-x', {
          term: request.term + 1,
          leaderId: 'node-x',
          prevLogIndex: 0,
          prevLogTerm: 0,
          entries: [],
          leaderCommit: 0
        });
      }

      return {
        term: request.term,
        success: false,
        matchIndex: 0
      };
    }
  });

  raft = createRaftNode<string>({
    nodeId: 'node-1',
    peerIds: ['node-2'],
    transport,
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000,
    proposalTimeoutMs: 300
  });

  await raft.start();
  try {
    await raft.startElection();
    assert.equal(raft.isLeader(), true);
    await assert.rejects(
      () => raft.propose('will-step-down'),
      (error: unknown) => isNotLeaderError(error)
    );
  } finally {
    await raft.stop();
  }
});

test('[unit/raft-coverage] replication stepdown handles higher-term append response path', async () => {
  let appendEntriesCalls = 0;
  const raft = createRaftNode<string>({
    nodeId: 'node-1',
    peerIds: ['node-2'],
    transport: createScriptedTransport({
      appendEntries: async (_fromNodeId, _toNodeId, request) => {
        appendEntriesCalls += 1;
        if (appendEntriesCalls <= 2) {
          return {
            term: request.term,
            success: true,
            matchIndex: request.prevLogIndex + request.entries.length
          };
        }

        return {
          term: request.term + 1,
          success: false,
          matchIndex: 0
        };
      }
    }),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000,
    heartbeatMs: 5
  });

  await raft.start();
  try {
    await raft.startElection();
    assert.equal(raft.isLeader(), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(raft.isLeader(), false);
  } finally {
    await raft.stop();
  }
});

test('[unit/raft-coverage] follower readBarrier is rejected immediately', async () => {
  const raft = createRaftNode<string>({
    nodeId: 'node-follower',
    peerIds: ['node-2'],
    transport: createScriptedTransport(),
    applyCommand: () => undefined,
    electionTimeoutMs: 10_000
  });

  await raft.start();
  try {
    await assert.rejects(
      () => raft.readBarrier(),
      (error: unknown) => isNotLeaderError(error)
    );
  } finally {
    await raft.stop();
  }
});
