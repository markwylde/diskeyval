export type RaftRole = 'follower' | 'candidate' | 'leader';

export type RaftLogEntry<T = unknown> = {
  index: number;
  term: number;
  command: T;
};

export type RequestVoteRequest = {
  term: number;
  candidateId: string;
  lastLogIndex: number;
  lastLogTerm: number;
};

export type RequestVoteResponse = {
  term: number;
  voteGranted: boolean;
};

export type AppendEntriesRequest<T = unknown> = {
  term: number;
  leaderId: string;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: RaftLogEntry<T>[];
  leaderCommit: number;
};

export type AppendEntriesResponse = {
  term: number;
  success: boolean;
  matchIndex: number;
};

export type RaftRpcEndpoint<T = unknown> = {
  onRequestVote: (fromNodeId: string, request: RequestVoteRequest) => Promise<RequestVoteResponse>;
  onAppendEntries: (
    fromNodeId: string,
    request: AppendEntriesRequest<T>
  ) => Promise<AppendEntriesResponse>;
};

export type RaftTransport<T = unknown> = {
  requestVote: (
    fromNodeId: string,
    toNodeId: string,
    request: RequestVoteRequest
  ) => Promise<RequestVoteResponse>;
  appendEntries: (
    fromNodeId: string,
    toNodeId: string,
    request: AppendEntriesRequest<T>
  ) => Promise<AppendEntriesResponse>;
};

export type ManagedRaftTransport<T = unknown> = RaftTransport<T> & {
  start?: (endpoint: RaftRpcEndpoint<T>) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  register?: (nodeId: string, endpoint: RaftRpcEndpoint<T>) => void;
  unregister?: (nodeId: string) => void;
  upsertPeer?: (peer: { nodeId: string; host: string; port: number }) => void;
  removePeer?: (nodeId: string) => void;
};

export type RaftNodeOptions<T = unknown> = {
  nodeId: string;
  peerIds: string[];
  transport: RaftTransport<T>;
  applyCommand: (entry: RaftLogEntry<T>) => void;
  electionTimeoutMs?: number;
  heartbeatMs?: number;
  proposalTimeoutMs?: number;
  retryBackoffMs?: number;
  maxReplicationPassesPerRound?: number;
  storage?: RaftStorage<T>;
  random?: () => number;
};

export type RaftPersistentState<T = unknown> = {
  currentTerm: number;
  votedFor: string | null;
  log: RaftLogEntry<T>[];
  commitIndex: number;
};

export type RaftStorage<T = unknown> = {
  load: () => Promise<RaftPersistentState<T> | null>;
  save: (state: RaftPersistentState<T>) => Promise<void>;
};

export type RaftMetrics = {
  electionsStarted: number;
  leadershipsWon: number;
  requestVoteSent: number;
  requestVoteFailed: number;
  appendEntriesSent: number;
  appendEntriesFailed: number;
  appendEntriesRetries: number;
  proposalsReceived: number;
  proposalTimeouts: number;
  proposalsCommitted: number;
  readBarriersRequested: number;
  readBarriersFailed: number;
  commitsApplied: number;
  persistenceSaves: number;
  persistenceSaveFailures: number;
  persistenceLoads: number;
  persistenceLoadFailures: number;
};

export type NotLeaderError = Error & {
  name: 'NotLeaderError';
  leaderId: string | null;
};

export type QuorumUnavailableError = Error & {
  name: 'QuorumUnavailableError';
};

export function createNotLeaderError(message: string, leaderId: string | null): NotLeaderError {
  const error = new Error(message) as NotLeaderError;
  error.name = 'NotLeaderError';
  error.leaderId = leaderId;
  return error;
}

export function createQuorumUnavailableError(message: string): QuorumUnavailableError {
  const error = new Error(message) as QuorumUnavailableError;
  error.name = 'QuorumUnavailableError';
  return error;
}

export function isNotLeaderError(error: unknown): error is NotLeaderError {
  return (
    !!error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: string }).name === 'NotLeaderError'
  );
}

export function isQuorumUnavailableError(error: unknown): error is QuorumUnavailableError {
  return (
    !!error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: string }).name === 'QuorumUnavailableError'
  );
}
