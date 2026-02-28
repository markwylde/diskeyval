import {
  createInMemoryRaftNetwork,
  type InMemoryRaftNetwork
} from './raft/in-memory-network.ts';
import { createRaftNode, type RaftNode } from './raft/node.ts';
import { createTlsRaftTransport, type TlsPeer } from './raft/tls-transport.ts';
import {
  createNotLeaderError,
  createQuorumUnavailableError,
  isNotLeaderError,
  isQuorumUnavailableError,
  type ManagedRaftTransport,
  type RaftMetrics,
  type RaftLogEntry,
  type RaftRole,
  type RaftTransport
} from './raft/types.ts';
import { createFileRaftStorage } from './storage/file-raft-storage.ts';

export type SetCommand = {
  type: 'set';
  key: string;
  value: unknown;
};

export type ClusterPeer = {
  nodeId: string;
  host?: string;
  port?: number;
};

export type ReconfigureCommand = {
  type: 'reconfigure';
  peers: ClusterPeer[];
};

export type DiskeyvalCommand = SetCommand | ReconfigureCommand;

export type DiskeyvalOptions = {
  nodeId: string;
  peers: string[] | TlsPeer[];
  transport?: RaftTransport<DiskeyvalCommand>;
  host?: string;
  port?: number;
  tls?: {
    cert: string;
    key: string;
    ca: string;
    servername?: string;
  };
  rpcTimeoutMs?: number;
  persistence?: {
    dir: string;
    compactEvery?: number;
  };
  electionTimeoutMs?: number;
  heartbeatMs?: number;
  proposalTimeoutMs?: number;
};

type DiskeyvalEvents = {
  change: {
    key: string;
    value: unknown;
  };
  leader: {
    nodeId: string | null;
  };
};

type EventKey = keyof DiskeyvalEvents;

type EventHandler<K extends EventKey> = (payload: DiskeyvalEvents[K]) => void;

function createEventBus() {
  const handlers = new Map<EventKey, Set<(payload: unknown) => void>>();

  const on = <K extends EventKey>(event: K, handler: EventHandler<K>): void => {
    const existing = handlers.get(event);
    if (existing) {
      existing.add(handler as (payload: unknown) => void);
      return;
    }
    handlers.set(event, new Set([(handler as (payload: unknown) => void)]));
  };

  const off = <K extends EventKey>(event: K, handler: EventHandler<K>): void => {
    const existing = handlers.get(event);
    if (!existing) {
      return;
    }
    existing.delete(handler as (payload: unknown) => void);
    if (existing.size === 0) {
      handlers.delete(event);
    }
  };

  const emit = <K extends EventKey>(event: K, payload: DiskeyvalEvents[K]): void => {
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

export type DiskeyvalNode = {
  nodeId: string;
  state: Record<string, unknown>;
  start: () => Promise<void>;
  end: () => Promise<void>;
  set: (key: string, value: unknown) => Promise<void>;
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  reconfigure: (peers: ClusterPeer[]) => Promise<void>;
  getPeers: () => ClusterPeer[];
  isLeader: () => boolean;
  leaderId: () => string | null;
  getRaftNode: () => RaftNode<DiskeyvalCommand>;
  getMetrics: () => RaftMetrics;
  forceElection: () => Promise<void>;
  on: <K extends EventKey>(event: K, handler: EventHandler<K>) => void;
  off: <K extends EventKey>(event: K, handler: EventHandler<K>) => void;
};

type DiskeyvalContext = {
  nodeId: string;
  selfPeer: ClusterPeer;
  state: Record<string, unknown>;
  raft: RaftNode<DiskeyvalCommand>;
  transport: ManagedRaftTransport<DiskeyvalCommand>;
  events: ReturnType<typeof createEventBus>;
  peersById: Map<string, ClusterPeer>;
};

function extractPeerRecords(peers: DiskeyvalOptions['peers']): ClusterPeer[] {
  if (peers.length === 0) {
    return [];
  }

  if (typeof peers[0] === 'string') {
    return (peers as string[]).map((nodeId) => ({ nodeId }));
  }

  return (peers as TlsPeer[]).map((peer) => ({
    nodeId: peer.nodeId,
    host: peer.host,
    port: peer.port
  }));
}

function extractPeerIds(peers: ClusterPeer[]): string[] {
  return peers.map((peer) => peer.nodeId);
}

function normalizePeers(selfNodeId: string, incoming: ClusterPeer[]): ClusterPeer[] {
  const deduped = new Map<string, ClusterPeer>();
  for (const peer of incoming) {
    if (!peer.nodeId || peer.nodeId === selfNodeId) {
      continue;
    }
    deduped.set(peer.nodeId, {
      nodeId: peer.nodeId,
      host: peer.host,
      port: peer.port
    });
  }

  return Array.from(deduped.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

function normalizeMembers(incoming: ClusterPeer[]): ClusterPeer[] {
  const deduped = new Map<string, ClusterPeer>();
  for (const peer of incoming) {
    if (!peer.nodeId) {
      continue;
    }
    deduped.set(peer.nodeId, {
      nodeId: peer.nodeId,
      host: peer.host,
      port: peer.port
    });
  }

  return Array.from(deduped.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

function resolveTransport(options: DiskeyvalOptions): ManagedRaftTransport<DiskeyvalCommand> {
  if (options.transport) {
    return options.transport as ManagedRaftTransport<DiskeyvalCommand>;
  }

  if (!options.host || !options.port || !options.tls) {
    throw new Error('Either provide transport, or provide host/port/tls for built-in TLS transport');
  }

  const peers = options.peers as TlsPeer[];
  return createTlsRaftTransport<DiskeyvalCommand>({
    nodeId: options.nodeId,
    host: options.host,
    port: options.port,
    peers,
    tls: options.tls,
    rpcTimeoutMs: options.rpcTimeoutMs
  });
}

function createRpcEndpoint(context: DiskeyvalContext) {
  return {
    onRequestVote: context.raft.onRequestVote,
    onAppendEntries: context.raft.onAppendEntries
  };
}

function applyMembership(context: DiskeyvalContext, peers: ClusterPeer[]): void {
  const normalized = normalizePeers(context.nodeId, peers);

  const nextIds = new Set(normalized.map((peer) => peer.nodeId));
  for (const existingId of context.peersById.keys()) {
    if (nextIds.has(existingId)) {
      continue;
    }
    context.peersById.delete(existingId);
    if (typeof context.transport.removePeer === 'function') {
      context.transport.removePeer(existingId);
    }
  }

  for (const peer of normalized) {
    context.peersById.set(peer.nodeId, peer);
    if (
      typeof context.transport.upsertPeer === 'function' &&
      typeof peer.host === 'string' &&
      typeof peer.port === 'number'
    ) {
      context.transport.upsertPeer({
        nodeId: peer.nodeId,
        host: peer.host,
        port: peer.port
      });
    }
  }

  context.raft.replacePeers(normalized.map((peer) => peer.nodeId));
}

export function diskeyval(options: DiskeyvalOptions): DiskeyvalNode {
  const events = createEventBus();
  const state: Record<string, unknown> = {};
  let started = false;
  const transport = resolveTransport(options);
  const initialPeers = normalizePeers(options.nodeId, extractPeerRecords(options.peers));
  const peersById = new Map(initialPeers.map((peer) => [peer.nodeId, peer]));

  const raft = createRaftNode<DiskeyvalCommand>({
    nodeId: options.nodeId,
    peerIds: extractPeerIds(initialPeers),
    transport,
    electionTimeoutMs: options.electionTimeoutMs,
    heartbeatMs: options.heartbeatMs,
    proposalTimeoutMs: options.proposalTimeoutMs,
    storage:
      options.persistence !== undefined
        ? createFileRaftStorage<DiskeyvalCommand>({
            dir: options.persistence.dir,
            nodeId: options.nodeId,
            compactEvery: options.persistence.compactEvery
          })
        : undefined,
    applyCommand: (entry) => {
      if (entry.command.type === 'set') {
        state[entry.command.key] = entry.command.value;
        if (started) {
          events.emit('change', { key: entry.command.key, value: entry.command.value });
        }
        return;
      }

      if (entry.command.type === 'reconfigure') {
        applyMembership(context, entry.command.peers);
      }
    }
  });

  const context: DiskeyvalContext = {
    nodeId: options.nodeId,
    selfPeer: {
      nodeId: options.nodeId,
      host: options.host,
      port: options.port
    },
    state,
    raft,
    transport,
    events,
    peersById
  };

  if (typeof context.transport.register === 'function') {
    context.transport.register(context.nodeId, createRpcEndpoint(context));
  }

  for (const peer of initialPeers) {
    if (
      typeof context.transport.upsertPeer === 'function' &&
      typeof peer.host === 'string' &&
      typeof peer.port === 'number'
    ) {
      context.transport.upsertPeer({
        nodeId: peer.nodeId,
        host: peer.host,
        port: peer.port
      });
    }
  }

  context.raft.on('leader', (leaderNodeId: string | null) => {
    context.events.emit('leader', { nodeId: leaderNodeId });
  });

  const start = async (): Promise<void> => {
    if (typeof context.transport.start === 'function') {
      await context.transport.start(createRpcEndpoint(context));
    }
    await context.raft.start();
    started = true;
  };

  const end = async (): Promise<void> => {
    await context.raft.stop();
    if (typeof context.transport.unregister === 'function') {
      context.transport.unregister(context.nodeId);
    }
    if (typeof context.transport.stop === 'function') {
      await context.transport.stop();
    }
  };

  const set = async (key: string, value: unknown): Promise<void> => {
    await context.raft.propose({
      type: 'set',
      key,
      value
    });
  };

  const get = async <T = unknown>(key: string): Promise<T | undefined> => {
    if (!context.raft.isLeader()) {
      throw createNotLeaderError('Reads must go to the leader', context.raft.leaderId());
    }

    await context.raft.readBarrier();
    return context.state[key] as T | undefined;
  };

  const reconfigure = async (peers: ClusterPeer[]): Promise<void> => {
    const normalized = normalizeMembers([...peers, context.selfPeer]);

    await context.raft.propose({
      type: 'reconfigure',
      peers: normalized
    });
  };

  const getPeers = (): ClusterPeer[] => {
    return Array.from(context.peersById.values()).map((peer) => ({ ...peer }));
  };

  return {
    nodeId: context.nodeId,
    state: context.state,
    start,
    end,
    set,
    get,
    reconfigure,
    getPeers,
    isLeader: context.raft.isLeader,
    leaderId: context.raft.leaderId,
    getRaftNode: () => context.raft,
    getMetrics: context.raft.getMetrics,
    forceElection: context.raft.startElection,
    on: context.events.on,
    off: context.events.off
  };
}

export function createInMemoryDiskeyvalCluster(
  nodeIds: string[],
  options?: {
    electionTimeoutMs?: number;
    heartbeatMs?: number;
    proposalTimeoutMs?: number;
  }
): {
  network: InMemoryRaftNetwork<DiskeyvalCommand>;
  nodes: Record<string, DiskeyvalNode>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const network = createInMemoryRaftNetwork<DiskeyvalCommand>();
  const nodes: Record<string, DiskeyvalNode> = {};

  for (const nodeId of nodeIds) {
    const peers = nodeIds
      .filter((candidateId) => candidateId !== nodeId)
      .map((candidateId) => ({ nodeId: candidateId }));

    nodes[nodeId] = diskeyval({
      nodeId,
      peers,
      transport: network,
      electionTimeoutMs: options?.electionTimeoutMs,
      heartbeatMs: options?.heartbeatMs,
      proposalTimeoutMs: options?.proposalTimeoutMs
    });
  }

  return {
    network,
    nodes,
    start: async () => {
      await Promise.all(Object.values(nodes).map(async (node) => node.start()));
    },
    stop: async () => {
      await Promise.all(Object.values(nodes).map(async (node) => node.end()));
    }
  };
}

export { createInMemoryRaftNetwork, createRaftNode, createTlsRaftTransport };
export { createFileRaftStorage };
export {
  createNotLeaderError,
  createQuorumUnavailableError,
  isNotLeaderError,
  isQuorumUnavailableError
};
export type { RaftLogEntry, RaftRole, TlsPeer };

export default diskeyval;
