# diskeyval

## Installation
```bash
npm install --save diskeyval
```

## Overview
`diskeyval` is a distributed in-memory key/value store with Raft consensus.

- `set(key, value)` resolves only after majority commit.
- `get(key)` resolves from majority-committed state.
- Dynamic cluster reconfiguration is implemented via `reconfigure(peers)`.
- Inter-node communication uses mTLS with CA-signed certs.
- Implementation style is functional/context-based (no classes or interfaces).

## API Example
```typescript
import diskeyval from 'diskeyval';

const node1 = diskeyval({
  nodeId: 'node-1',
  host: '127.0.0.1',
  port: 8050,
  peers: [
    { nodeId: 'node-2', host: '127.0.0.1', port: 8051 },
    { nodeId: 'node-3', host: '127.0.0.1', port: 8052 }
  ],
  tls: {
    cert: process.env.NODE1_CERT_PEM!,
    key: process.env.NODE1_KEY_PEM!,
    ca: process.env.CLUSTER_CA_PEM!
  }
});

const node2 = diskeyval({
  nodeId: 'node-2',
  host: '127.0.0.1',
  port: 8051,
  peers: [
    { nodeId: 'node-1', host: '127.0.0.1', port: 8050 },
    { nodeId: 'node-3', host: '127.0.0.1', port: 8052 }
  ],
  tls: {
    cert: process.env.NODE2_CERT_PEM!,
    key: process.env.NODE2_KEY_PEM!,
    ca: process.env.CLUSTER_CA_PEM!
  }
});

await node1.start();
await node2.start();

await node1.set('testkey', 'testvalue1');
const value = await node1.get('testkey');

node1.on('change', ({ key, value }) => {
  console.log('changed', key, value);
});

await node1.end();
await node2.end();
```

## Options
```typescript
type DiskeyvalOptions = {
  nodeId: string;

  // Required for built-in TLS transport:
  host?: string;
  port?: number;
  peers: string[] | Array<{ nodeId: string; host: string; port: number }>;
  tls?: {
    cert: string;
    key: string;
    ca: string;
  };

  // Optional custom transport (used by simulation/in-memory tests):
  transport?: RaftTransport<SetCommand>;
  persistence?: {
    dir: string;
    compactEvery?: number;
  };

  electionTimeoutMs?: number;
  heartbeatMs?: number;
  proposalTimeoutMs?: number;
  rpcTimeoutMs?: number;
};
```

## Methods
- `start(): Promise<void>`
- `set(key: string, value: unknown): Promise<void>`
- `get<T = unknown>(key: string): Promise<T | undefined>`
- `reconfigure(peers: ClusterPeer[]): Promise<void>`
- `getPeers(): ClusterPeer[]`
- `end(): Promise<void>`
- `isLeader(): boolean`
- `leaderId(): string | null`
- `getMetrics(): RaftMetrics`

## Dynamic Membership
- Reconfiguration is consensus-committed through the Raft log.
- Nodes apply committed membership updates at the same log index as other commands.
- New members catch up from the leader after being added.

## Events
- `change` with payload `{ key: string; value: unknown }`
- `leader` with payload `{ nodeId: string | null }`

## Guarantees
- Majority-acknowledged writes.
- Majority-consistent reads.
- Single committed global write order through Raft.
- mTLS-authenticated inter-node RPC with cert identity checks (CN/SAN).
- File-backed durability via WAL + periodic snapshot compaction when `persistence` is enabled.
