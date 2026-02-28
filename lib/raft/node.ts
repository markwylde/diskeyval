import {
  createNotLeaderError,
  createQuorumUnavailableError,
  type AppendEntriesRequest,
  type AppendEntriesResponse,
  type RaftLogEntry,
  type RaftMetrics,
  type RaftNodeOptions,
  type RaftPersistentState,
  type RaftRole,
  type RequestVoteRequest,
  type RequestVoteResponse
} from './types.ts';

const INITIAL_LOG_ENTRY: RaftLogEntry<unknown> = {
  index: 0,
  term: 0,
  command: null
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PendingProposal = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type RaftNodeEventMap<T> = {
  'role-change': RaftRole;
  leader: string | null;
  commit: RaftLogEntry<T>;
};

type EventKey<T> = keyof RaftNodeEventMap<T>;
type EventHandler<T, K extends EventKey<T>> = (payload: RaftNodeEventMap<T>[K]) => void;

function createEventBus<T>() {
  const handlers = new Map<keyof RaftNodeEventMap<T>, Set<(payload: unknown) => void>>();

  const on = <K extends EventKey<T>>(event: K, handler: EventHandler<T, K>): void => {
    const existing = handlers.get(event);
    if (existing) {
      existing.add(handler as (payload: unknown) => void);
      return;
    }

    handlers.set(event, new Set([(handler as (payload: unknown) => void)]));
  };

  const off = <K extends EventKey<T>>(event: K, handler: EventHandler<T, K>): void => {
    const existing = handlers.get(event);
    if (!existing) {
      return;
    }

    existing.delete(handler as (payload: unknown) => void);
    if (existing.size === 0) {
      handlers.delete(event);
    }
  };

  const emit = <K extends EventKey<T>>(event: K, payload: RaftNodeEventMap<T>[K]): void => {
    const existing = handlers.get(event);
    if (!existing) {
      return;
    }

    for (const handler of existing) {
      handler(payload);
    }
  };

  return {
    on,
    off,
    emit
  };
}

function createRaftMetrics(): RaftMetrics {
  return {
    electionsStarted: 0,
    leadershipsWon: 0,
    requestVoteSent: 0,
    requestVoteFailed: 0,
    appendEntriesSent: 0,
    appendEntriesFailed: 0,
    appendEntriesRetries: 0,
    proposalsReceived: 0,
    proposalTimeouts: 0,
    proposalsCommitted: 0,
    readBarriersRequested: 0,
    readBarriersFailed: 0,
    commitsApplied: 0,
    persistenceSaves: 0,
    persistenceSaveFailures: 0,
    persistenceLoads: 0,
    persistenceLoadFailures: 0
  };
}

export type RaftNodeStateSnapshot = {
  role: RaftRole;
  currentTerm: number;
  commitIndex: number;
  lastApplied: number;
  lastLogIndex: number;
  leaderNodeId: string | null;
};

export type RaftNode<T = unknown> = {
  nodeId: string;
  peerIds: string[];
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isLeader: () => boolean;
  leaderId: () => string | null;
  getState: () => RaftNodeStateSnapshot;
  getMetrics: () => RaftMetrics;
  replacePeers: (peerIds: string[]) => void;
  startElection: () => Promise<void>;
  propose: (command: T) => Promise<void>;
  readBarrier: () => Promise<void>;
  onRequestVote: (fromNodeId: string, request: RequestVoteRequest) => Promise<RequestVoteResponse>;
  onAppendEntries: (
    fromNodeId: string,
    request: AppendEntriesRequest<T>
  ) => Promise<AppendEntriesResponse>;
  on: <K extends EventKey<T>>(event: K, handler: EventHandler<T, K>) => void;
  off: <K extends EventKey<T>>(event: K, handler: EventHandler<T, K>) => void;
};

type RaftRuntimeContext<T> = {
  nodeId: string;
  peerIds: string[];
  transport: RaftNodeOptions<T>['transport'];
  applyCommand: RaftNodeOptions<T>['applyCommand'];
  electionTimeoutMs: number;
  heartbeatMs: number;
  proposalTimeoutMs: number;
  retryBackoffMs: number;
  maxReplicationPassesPerRound: number;
  storage?: RaftNodeOptions<T>['storage'];
  random: () => number;

  electionTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;

  running: boolean;

  role: RaftRole;
  currentTerm: number;
  votedFor: string | null;
  leaderNodeId: string | null;

  log: RaftLogEntry<T>[];
  commitIndex: number;
  lastApplied: number;

  nextIndex: Map<string, number>;
  matchIndex: Map<string, number>;

  pendingProposals: Map<number, PendingProposal>;

  persistQueue: Promise<void>;
  events: ReturnType<typeof createEventBus<T>>;
  metrics: RaftMetrics;
};

function incrementMetric(context: RaftRuntimeContext<unknown>, key: keyof RaftMetrics, amount = 1): void {
  context.metrics[key] += amount;
}

function lastLogIndex<T>(context: RaftRuntimeContext<T>): number {
  return context.log.length - 1;
}

function lastLogTerm<T>(context: RaftRuntimeContext<T>): number {
  return context.log[lastLogIndex(context)]?.term ?? 0;
}

function majorityCount<T>(context: RaftRuntimeContext<T>): number {
  const totalNodes = context.peerIds.length + 1;
  return Math.floor(totalNodes / 2) + 1;
}

function clearElectionTimer<T>(context: RaftRuntimeContext<T>): void {
  if (!context.electionTimer) {
    return;
  }

  clearTimeout(context.electionTimer);
  context.electionTimer = null;
}

function clearHeartbeatTimer<T>(context: RaftRuntimeContext<T>): void {
  if (!context.heartbeatTimer) {
    return;
  }

  clearInterval(context.heartbeatTimer);
  context.heartbeatTimer = null;
}

function resetElectionTimer<T>(context: RaftRuntimeContext<T>, startElectionFn: () => Promise<void>): void {
  if (!context.running) {
    return;
  }

  clearElectionTimer(context);
  const jitter = Math.floor(context.random() * context.electionTimeoutMs);
  context.electionTimer = setTimeout(() => {
    void startElectionFn();
  }, context.electionTimeoutMs + jitter);
}

function logMatches<T>(context: RaftRuntimeContext<T>, index: number, term: number): boolean {
  const entry = context.log[index];
  return !!entry && entry.term === term;
}

function isCandidateLogUpToDate<T>(
  context: RaftRuntimeContext<T>,
  candidateLastLogIndex: number,
  candidateLastLogTerm: number
): boolean {
  const localLastLogTerm = lastLogTerm(context);
  if (candidateLastLogTerm !== localLastLogTerm) {
    return candidateLastLogTerm > localLastLogTerm;
  }
  return candidateLastLogIndex >= lastLogIndex(context);
}

function persistentStateFromContext<T>(context: RaftRuntimeContext<T>): RaftPersistentState<T> {
  return {
    currentTerm: context.currentTerm,
    votedFor: context.votedFor,
    log: context.log,
    commitIndex: context.commitIndex
  };
}

function schedulePersist<T>(context: RaftRuntimeContext<T>): void {
  if (!context.storage) {
    return;
  }

  const state = persistentStateFromContext(context);
  context.persistQueue = context.persistQueue
    .then(async () => {
      await context.storage?.save(state);
      incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'persistenceSaves');
    })
    .catch(() => {
      incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'persistenceSaveFailures');
    });
}

function mergeEntries<T>(
  context: RaftRuntimeContext<T>,
  prevLogIndex: number,
  incomingEntries: RaftLogEntry<T>[]
): void {
  let writeIndex = prevLogIndex + 1;

  for (const incomingEntry of incomingEntries) {
    const currentEntry = context.log[writeIndex];
    if (currentEntry && currentEntry.term !== incomingEntry.term) {
      context.log.splice(writeIndex);
    }

    if (!context.log[writeIndex]) {
      context.log[writeIndex] = {
        index: writeIndex,
        term: incomingEntry.term,
        command: incomingEntry.command
      };
    }

    writeIndex += 1;
  }
}

function applyCommittedEntries<T>(context: RaftRuntimeContext<T>, emitEvents: boolean): void {
  while (context.lastApplied < context.commitIndex) {
    context.lastApplied += 1;
    const entry = context.log[context.lastApplied];
    context.applyCommand(entry);
    incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'commitsApplied');
    if (emitEvents) {
      context.events.emit('commit', entry);
    }
  }
}

function resolveCommittedProposals<T>(context: RaftRuntimeContext<T>): void {
  for (const [entryIndex, pendingProposal] of context.pendingProposals.entries()) {
    if (entryIndex > context.commitIndex) {
      continue;
    }

    pendingProposal.resolve();
    context.pendingProposals.delete(entryIndex);
    incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'proposalsCommitted');
  }
}

function transitionToFollower<T>(
  context: RaftRuntimeContext<T>,
  term: number,
  leaderNodeId: string | null,
  startElectionFn: () => Promise<void>
): void {
  if (term > context.currentTerm) {
    context.currentTerm = term;
    context.votedFor = null;
  }

  context.role = 'follower';
  context.leaderNodeId = leaderNodeId;

  clearHeartbeatTimer(context);
  resetElectionTimer(context, startElectionFn);

  context.events.emit('role-change', context.role);
  context.events.emit('leader', context.leaderNodeId);

  for (const [entryIndex, pendingProposal] of context.pendingProposals.entries()) {
    if (entryIndex <= context.commitIndex) {
      continue;
    }

    pendingProposal.reject(createNotLeaderError('Leader stepped down before commit', context.leaderNodeId));
    context.pendingProposals.delete(entryIndex);
  }

  schedulePersist(context);
}

function transitionToCandidate<T>(
  context: RaftRuntimeContext<T>,
  startElectionFn: () => Promise<void>
): void {
  context.role = 'candidate';
  context.currentTerm += 1;
  context.votedFor = context.nodeId;
  context.leaderNodeId = null;

  clearHeartbeatTimer(context);
  resetElectionTimer(context, startElectionFn);

  context.events.emit('role-change', context.role);
  context.events.emit('leader', context.leaderNodeId);

  schedulePersist(context);
}

function createAppendEntriesRequest<T>(
  context: RaftRuntimeContext<T>,
  prevLogIndex: number,
  entries: RaftLogEntry<T>[]
): AppendEntriesRequest<T> {
  return {
    term: context.currentTerm,
    leaderId: context.nodeId,
    prevLogIndex,
    prevLogTerm: context.log[prevLogIndex]?.term ?? 0,
    entries,
    leaderCommit: context.commitIndex
  };
}

async function replicateToPeer<T>(
  context: RaftRuntimeContext<T>,
  peerId: string,
  startElectionFn: () => Promise<void>
): Promise<void> {
  if (context.role !== 'leader') {
    return;
  }

  for (let pass = 0; pass < context.maxReplicationPassesPerRound; pass += 1) {
    if (context.role !== 'leader') {
      return;
    }

    const nextPeerIndex = context.nextIndex.get(peerId) ?? lastLogIndex(context) + 1;
    const entries = context.log.slice(nextPeerIndex);
    const request = createAppendEntriesRequest(context, nextPeerIndex - 1, entries);

    incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'appendEntriesSent');

    try {
      const response = await context.transport.appendEntries(context.nodeId, peerId, request);

      if (response.term > context.currentTerm) {
        transitionToFollower(context, response.term, null, startElectionFn);
        return;
      }

      if (context.role !== 'leader') {
        return;
      }

      if (response.success) {
        context.matchIndex.set(peerId, response.matchIndex);
        context.nextIndex.set(peerId, response.matchIndex + 1);

        if (response.matchIndex >= lastLogIndex(context)) {
          return;
        }

        incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'appendEntriesRetries');
        continue;
      }

      context.nextIndex.set(peerId, Math.max(1, nextPeerIndex - 1));
      incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'appendEntriesRetries');
      await delay(context.retryBackoffMs);
    } catch {
      incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'appendEntriesFailed');
      await delay(context.retryBackoffMs);
    }
  }
}

function advanceCommitIndex<T>(context: RaftRuntimeContext<T>): void {
  if (context.role !== 'leader') {
    return;
  }

  for (let entryIndex = lastLogIndex(context); entryIndex > context.commitIndex; entryIndex -= 1) {
    const entry = context.log[entryIndex];
    if (!entry || entry.term !== context.currentTerm) {
      continue;
    }

    let replicated = 1;
    for (const peerId of context.peerIds) {
      const peerMatchIndex = context.matchIndex.get(peerId) ?? 0;
      if (peerMatchIndex >= entryIndex) {
        replicated += 1;
      }
    }

    if (replicated < majorityCount(context)) {
      continue;
    }

    context.commitIndex = entryIndex;
    applyCommittedEntries(context, true);
    resolveCommittedProposals(context);
    schedulePersist(context);
    break;
  }
}

function ensureValidLoadedLog<T>(loadedLog: RaftLogEntry<T>[]): RaftLogEntry<T>[] {
  if (loadedLog.length === 0) {
    return [INITIAL_LOG_ENTRY as RaftLogEntry<T>];
  }

  const first = loadedLog[0];
  if (first.index === 0 && first.term === 0) {
    return loadedLog;
  }

  return [INITIAL_LOG_ENTRY as RaftLogEntry<T>, ...loadedLog];
}

export function createRaftNode<T>(options: RaftNodeOptions<T>): RaftNode<T> {
  const context: RaftRuntimeContext<T> = {
    nodeId: options.nodeId,
    peerIds: [...options.peerIds],
    transport: options.transport,
    applyCommand: options.applyCommand,
    electionTimeoutMs: options.electionTimeoutMs ?? 200,
    heartbeatMs: options.heartbeatMs ?? 50,
    proposalTimeoutMs: options.proposalTimeoutMs ?? 1_000,
    retryBackoffMs: options.retryBackoffMs ?? 5,
    maxReplicationPassesPerRound: options.maxReplicationPassesPerRound ?? 3,
    storage: options.storage,
    random: options.random ?? Math.random,

    electionTimer: null,
    heartbeatTimer: null,

    running: false,

    role: 'follower',
    currentTerm: 0,
    votedFor: null,
    leaderNodeId: null,

    log: [INITIAL_LOG_ENTRY as RaftLogEntry<T>],
    commitIndex: 0,
    lastApplied: 0,

    nextIndex: new Map<string, number>(),
    matchIndex: new Map<string, number>(),

    pendingProposals: new Map<number, PendingProposal>(),

    persistQueue: Promise.resolve(),
    events: createEventBus<T>(),
    metrics: createRaftMetrics()
  };

  const replicateRound = async (): Promise<void> => {
    if (context.role !== 'leader') {
      return;
    }

    await Promise.all(
      context.peerIds.map(async (peerId) => replicateToPeer(context, peerId, startElection))
    );

    advanceCommitIndex(context);
  };

  const replacePeers = (incomingPeerIds: string[]): void => {
    const unique = Array.from(new Set(incomingPeerIds.filter((peerId) => peerId !== context.nodeId)));
    const previous = new Set(context.peerIds);
    const next = new Set(unique);

    for (const peerId of context.peerIds) {
      if (next.has(peerId)) {
        continue;
      }
      context.nextIndex.delete(peerId);
      context.matchIndex.delete(peerId);
    }

    context.peerIds.splice(0, context.peerIds.length, ...unique);

    for (const peerId of context.peerIds) {
      if (previous.has(peerId)) {
        continue;
      }

      if (context.role === 'leader') {
        context.nextIndex.set(peerId, 1);
        context.matchIndex.set(peerId, 0);
      } else {
        context.nextIndex.set(peerId, lastLogIndex(context) + 1);
        context.matchIndex.set(peerId, 0);
      }
    }
  };

  const startElection = async (): Promise<void> => {
    if (!context.running) {
      return;
    }

    incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'electionsStarted');
    transitionToCandidate(context, startElection);

    const request: RequestVoteRequest = {
      term: context.currentTerm,
      candidateId: context.nodeId,
      lastLogIndex: lastLogIndex(context),
      lastLogTerm: lastLogTerm(context)
    };

    let votes = 1;
    const majority = majorityCount(context);

    const becomeLeader = (): void => {
      context.role = 'leader';
      context.leaderNodeId = context.nodeId;
      clearElectionTimer(context);

      const nextLogIndex = lastLogIndex(context) + 1;
      context.matchIndex.set(context.nodeId, lastLogIndex(context));
      for (const followerId of context.peerIds) {
        context.nextIndex.set(followerId, nextLogIndex);
        context.matchIndex.set(followerId, 0);
      }

      clearHeartbeatTimer(context);
      context.heartbeatTimer = setInterval(() => {
        void replicateRound();
      }, context.heartbeatMs);

      incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'leadershipsWon');
      context.events.emit('role-change', context.role);
      context.events.emit('leader', context.leaderNodeId);

      void replicateRound();
      void replicateRound();
    };

    if (votes >= majority && context.role === 'candidate') {
      becomeLeader();
      return;
    }

    await Promise.all(
      context.peerIds.map(async (peerId) => {
        incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'requestVoteSent');

        try {
          const response = await context.transport.requestVote(context.nodeId, peerId, request);

          if (response.term > context.currentTerm) {
            transitionToFollower(context, response.term, null, startElection);
            return;
          }

          if (context.role !== 'candidate' || context.currentTerm !== request.term) {
            return;
          }

          if (!response.voteGranted) {
            return;
          }

          votes += 1;
          if (votes < majority || context.role !== 'candidate') {
            return;
          }

          becomeLeader();
        } catch {
          incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'requestVoteFailed');
        }
      })
    );
  };

  const start = async (): Promise<void> => {
    if (context.running) {
      return;
    }

    if (context.storage) {
      try {
        const loaded = await context.storage.load();
        incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'persistenceLoads');

        if (loaded) {
          context.currentTerm = loaded.currentTerm;
          context.votedFor = loaded.votedFor;
          context.log = ensureValidLoadedLog(loaded.log);
          context.commitIndex = Math.min(loaded.commitIndex, lastLogIndex(context));
          context.lastApplied = 0;
          applyCommittedEntries(context, false);
        }
      } catch {
        incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'persistenceLoadFailures');
      }
    }

    context.running = true;
    resetElectionTimer(context, startElection);
  };

  const stop = async (): Promise<void> => {
    context.running = false;
    clearElectionTimer(context);
    clearHeartbeatTimer(context);

    for (const pendingProposal of context.pendingProposals.values()) {
      pendingProposal.reject(new Error('Node stopped before proposal committed'));
    }
    context.pendingProposals.clear();

    await context.persistQueue;
  };

  const propose = async (command: T): Promise<void> => {
    incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'proposalsReceived');

    if (context.role !== 'leader') {
      throw createNotLeaderError('Writes must be handled by the current leader', context.leaderNodeId);
    }

    const entryIndex = context.log.length;
    const entry: RaftLogEntry<T> = {
      index: entryIndex,
      term: context.currentTerm,
      command
    };

    context.log.push(entry);
    context.matchIndex.set(context.nodeId, lastLogIndex(context));
    schedulePersist(context);

    await new Promise<void>(async (resolve, reject) => {
      context.pendingProposals.set(entryIndex, { resolve, reject });
      const deadline = Date.now() + context.proposalTimeoutMs;

      try {
        while (context.commitIndex < entryIndex) {
          if (context.role !== 'leader') {
            throw createNotLeaderError('Leadership changed before commit', context.leaderNodeId);
          }

          if (Date.now() > deadline) {
            incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'proposalTimeouts');
            throw createQuorumUnavailableError('Timed out waiting for majority replication');
          }

          await replicateRound();
          await delay(5);
        }

        await replicateRound();
      } catch (error) {
        const pending = context.pendingProposals.get(entryIndex);
        if (!pending) {
          return;
        }

        context.pendingProposals.delete(entryIndex);
        pending.reject(error);
      }
    });
  };

  const readBarrier = async (): Promise<void> => {
    incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'readBarriersRequested');

    if (context.role !== 'leader') {
      incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'readBarriersFailed');
      throw createNotLeaderError('Linearizable read requires leader', context.leaderNodeId);
    }

    const readTerm = context.currentTerm;
    let acknowledgements = 1;
    const request = createAppendEntriesRequest(context, lastLogIndex(context), []);

    await Promise.all(
      context.peerIds.map(async (peerId) => {
        incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'appendEntriesSent');

        try {
          const response = await context.transport.appendEntries(context.nodeId, peerId, request);

          if (response.term > context.currentTerm) {
            transitionToFollower(context, response.term, null, startElection);
            return;
          }

          if (context.currentTerm !== readTerm || context.role !== 'leader') {
            return;
          }

          if (response.success) {
            acknowledgements += 1;
          }
        } catch {
          incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'appendEntriesFailed');
        }
      })
    );

    if (context.currentTerm !== readTerm || context.role !== 'leader') {
      incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'readBarriersFailed');
      throw createNotLeaderError('Leadership changed during read barrier', context.leaderNodeId);
    }

    if (acknowledgements < majorityCount(context)) {
      incrementMetric(context as unknown as RaftRuntimeContext<unknown>, 'readBarriersFailed');
      throw createQuorumUnavailableError('Quorum unavailable for linearizable read');
    }
  };

  const onRequestVote = async (
    _fromNodeId: string,
    request: RequestVoteRequest
  ): Promise<RequestVoteResponse> => {
    if (!context.running) {
      throw new Error(`Node ${context.nodeId} is stopped`);
    }

    if (request.term < context.currentTerm) {
      return {
        term: context.currentTerm,
        voteGranted: false
      };
    }

    if (request.term > context.currentTerm) {
      transitionToFollower(context, request.term, null, startElection);
    }

    const candidateUpToDate = isCandidateLogUpToDate(
      context,
      request.lastLogIndex,
      request.lastLogTerm
    );
    const canVote = context.votedFor === null || context.votedFor === request.candidateId;
    const voteGranted = canVote && candidateUpToDate;

    if (voteGranted) {
      context.votedFor = request.candidateId;
      resetElectionTimer(context, startElection);
      schedulePersist(context);
    }

    return {
      term: context.currentTerm,
      voteGranted
    };
  };

  const onAppendEntries = async (
    _fromNodeId: string,
    request: AppendEntriesRequest<T>
  ): Promise<AppendEntriesResponse> => {
    if (!context.running) {
      throw new Error(`Node ${context.nodeId} is stopped`);
    }

    if (request.term < context.currentTerm) {
      return {
        term: context.currentTerm,
        success: false,
        matchIndex: lastLogIndex(context)
      };
    }

    if (request.term > context.currentTerm || context.role !== 'follower') {
      transitionToFollower(context, request.term, request.leaderId, startElection);
    }

    context.leaderNodeId = request.leaderId;
    resetElectionTimer(context, startElection);

    if (!logMatches(context, request.prevLogIndex, request.prevLogTerm)) {
      return {
        term: context.currentTerm,
        success: false,
        matchIndex: lastLogIndex(context)
      };
    }

    mergeEntries(context, request.prevLogIndex, request.entries);

    if (request.leaderCommit > context.commitIndex) {
      context.commitIndex = Math.min(request.leaderCommit, lastLogIndex(context));
      applyCommittedEntries(context, true);
    }

    schedulePersist(context);

    return {
      term: context.currentTerm,
      success: true,
      matchIndex: lastLogIndex(context)
    };
  };

  return {
    nodeId: context.nodeId,
    peerIds: context.peerIds,
    start,
    stop,
    isLeader: () => context.role === 'leader',
    leaderId: () => context.leaderNodeId,
    getState: () => ({
      role: context.role,
      currentTerm: context.currentTerm,
      commitIndex: context.commitIndex,
      lastApplied: context.lastApplied,
      lastLogIndex: lastLogIndex(context),
      leaderNodeId: context.leaderNodeId
    }),
    getMetrics: () => ({ ...context.metrics }),
    replacePeers,
    startElection,
    propose,
    readBarrier,
    onRequestVote,
    onAppendEntries,
    on: context.events.on,
    off: context.events.off
  };
}
