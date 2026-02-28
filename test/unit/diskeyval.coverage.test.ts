import assert from 'node:assert/strict';
import test from 'node:test';
import { diskeyval, type DiskeyvalCommand } from '../../lib/index.ts';
import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  ManagedRaftTransport,
  RaftRpcEndpoint,
  RequestVoteRequest,
  RequestVoteResponse
} from '../../lib/raft/types.ts';

function createAlwaysAckTransport(): ManagedRaftTransport<DiskeyvalCommand> & {
  starts: number;
  stops: number;
  registered: string[];
  unregistered: string[];
  upserts: string[];
  removes: string[];
} {
  const state = {
    starts: 0,
    stops: 0,
    registered: [] as string[],
    unregistered: [] as string[],
    upserts: [] as string[],
    removes: [] as string[]
  };

  let endpoint: RaftRpcEndpoint<DiskeyvalCommand> | null = null;

  const requestVote = async (
    _from: string,
    _to: string,
    request: RequestVoteRequest
  ): Promise<RequestVoteResponse> => ({
    term: request.term,
    voteGranted: true
  });

  const appendEntries = async (
    _from: string,
    _to: string,
    request: AppendEntriesRequest<DiskeyvalCommand>
  ): Promise<AppendEntriesResponse> => ({
    term: request.term,
    success: true,
    matchIndex: request.prevLogIndex + request.entries.length
  });

  const transport: ManagedRaftTransport<DiskeyvalCommand> & {
    starts: number;
    stops: number;
    registered: string[];
    unregistered: string[];
    upserts: string[];
    removes: string[];
  } = {
    get starts() {
      return state.starts;
    },
    get stops() {
      return state.stops;
    },
    get registered() {
      return state.registered;
    },
    get unregistered() {
      return state.unregistered;
    },
    get upserts() {
      return state.upserts;
    },
    get removes() {
      return state.removes;
    },
    requestVote,
    appendEntries,
    start: async (nextEndpoint) => {
      endpoint = nextEndpoint;
      state.starts += 1;
    },
    stop: async () => {
      endpoint = null;
      state.stops += 1;
    },
    register: (nodeId) => {
      state.registered.push(nodeId);
    },
    unregister: (nodeId) => {
      state.unregistered.push(nodeId);
    },
    upsertPeer: (peer) => {
      state.upserts.push(peer.nodeId);
    },
    removePeer: (nodeId) => {
      state.removes.push(nodeId);
    }
  };

  return transport;
}

test('[unit/diskeyval] throws when built-in transport is selected without host/port/tls', () => {
  assert.throws(
    () =>
      diskeyval({
        nodeId: 'node-missing-transport',
        peers: []
      }),
    /Either provide transport, or provide host\/port\/tls/i
  );
});

test('[unit/diskeyval] event bus, lifecycle hooks, and membership upsert/remove are exercised', async () => {
  const transport = createAlwaysAckTransport();

  const node = diskeyval({
    nodeId: 'node-1',
    peers: [
      { nodeId: 'node-2', host: '127.0.0.1', port: 5002 },
      { nodeId: 'node-3', host: '127.0.0.1', port: 5003 }
    ],
    transport,
    electionTimeoutMs: 10_000,
    heartbeatMs: 20,
    proposalTimeoutMs: 300
  });

  let changeEvents = 0;
  const onChange = (): void => {
    changeEvents += 1;
  };

  // Exercise "off" branch for missing event registration.
  node.off('change', onChange);
  node.on('change', onChange);
  // Exercise "on existing" branch.
  node.on('change', onChange);

  await node.start();
  await node.forceElection();
  await node.set('cover', true);

  node.off('change', onChange);
  // Exercise "off" branch after handlers set is deleted.
  node.off('change', onChange);

  assert.equal(changeEvents, 1);
  assert.ok(transport.starts >= 1);
  assert.deepEqual(transport.registered, ['node-1']);
  assert.ok(transport.upserts.includes('node-2'));
  assert.ok(transport.upserts.includes('node-3'));

  await node.reconfigure([
    { nodeId: 'node-3', host: '127.0.0.1', port: 5003 },
    { nodeId: 'node-4', host: '127.0.0.1', port: 5004 },
    { nodeId: '', host: '127.0.0.1', port: 5999 }
  ]);

  assert.ok(transport.removes.includes('node-2'));
  assert.ok(transport.upserts.includes('node-4'));

  const peers = node.getPeers();
  peers[0].nodeId = 'mutated';
  assert.notEqual(node.getPeers()[0].nodeId, 'mutated');

  await node.end();
  assert.deepEqual(transport.unregistered, ['node-1']);
  assert.ok(transport.stops >= 1);
});

test('[unit/diskeyval] accepts string peer ids and exposes normalized peers', async () => {
  const transport = createAlwaysAckTransport();
  const node = diskeyval({
    nodeId: 'node-1',
    peers: ['node-2', 'node-3', 'node-2'],
    transport,
    electionTimeoutMs: 10_000
  });

  try {
    await node.start();
    const peers = node.getPeers();
    assert.deepEqual(
      peers.map((peer) => peer.nodeId).sort(),
      ['node-2', 'node-3']
    );
    assert.equal(peers.every((peer) => peer.host === undefined && peer.port === undefined), true);
  } finally {
    await node.end();
  }
});
