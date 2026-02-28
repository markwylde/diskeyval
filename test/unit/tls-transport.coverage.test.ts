import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, createServer } from 'node:tls';
import { createTlsRaftTransport } from '../../lib/raft/tls-transport.ts';
import type { RaftRpcEndpoint } from '../../lib/raft/types.ts';
import { createTestCertificates, hasOpenSsl } from '../support/certs.ts';
import { getFreePorts } from '../support/ports.ts';

type Command = { type: 'set'; key: string; value: unknown };

function createEndpoint(options?: {
  onRequestVote?: RaftRpcEndpoint<Command>['onRequestVote'];
  onAppendEntries?: RaftRpcEndpoint<Command>['onAppendEntries'];
}): RaftRpcEndpoint<Command> {
  return {
    onRequestVote:
      options?.onRequestVote ??
      (async (_fromNodeId, request) => ({
        term: request.term,
        voteGranted: true
      })),
    onAppendEntries:
      options?.onAppendEntries ??
      (async (_fromNodeId, request) => ({
        term: request.term,
        success: true,
        matchIndex: request.prevLogIndex + request.entries.length
      }))
  };
}

test('[unit/tls-transport] unknown peers and start/stop idempotency', { skip: !hasOpenSsl() }, async () => {
  const certs = createTestCertificates(['node-a']);
  const [port] = await getFreePorts(1);
  const transport = createTlsRaftTransport<Command>({
    nodeId: 'node-a',
    host: '127.0.0.1',
    port,
    peers: [],
    tls: {
      cert: certs.nodes['node-a'].certPem,
      key: certs.nodes['node-a'].keyPem,
      ca: certs.caPem
    },
    rpcTimeoutMs: 500
  });

  try {
    await assert.rejects(
      () =>
        transport.requestVote('node-a', 'node-missing', {
          term: 1,
          candidateId: 'node-a',
          lastLogIndex: 0,
          lastLogTerm: 0
        }),
      /Unknown peer/i
    );

    await transport.stop();
    await transport.start(createEndpoint());
    await transport.start(createEndpoint());
    await transport.stop();
    await transport.stop();
  } finally {
    certs.cleanup();
  }
});

test('[unit/tls-transport] rpc propagates remote endpoint errors', { skip: !hasOpenSsl() }, async () => {
  const certs = createTestCertificates(['node-a', 'node-b']);
  const [portA, portB] = await getFreePorts(2);

  const transportA = createTlsRaftTransport<Command>({
    nodeId: 'node-a',
    host: '127.0.0.1',
    port: portA,
    peers: [{ nodeId: 'node-b', host: '127.0.0.1', port: portB }],
    tls: {
      cert: certs.nodes['node-a'].certPem,
      key: certs.nodes['node-a'].keyPem,
      ca: certs.caPem
    },
    rpcTimeoutMs: 1_000
  });

  const transportB = createTlsRaftTransport<Command>({
    nodeId: 'node-b',
    host: '127.0.0.1',
    port: portB,
    peers: [{ nodeId: 'node-a', host: '127.0.0.1', port: portA }],
    tls: {
      cert: certs.nodes['node-b'].certPem,
      key: certs.nodes['node-b'].keyPem,
      ca: certs.caPem
    },
    rpcTimeoutMs: 1_000
  });

  try {
    await transportA.start(createEndpoint());
    await transportB.start(
      createEndpoint({
        onRequestVote: async () => {
          throw new Error('boom-from-endpoint');
        }
      })
    );

    await assert.rejects(
      () =>
        transportA.requestVote('node-a', 'node-b', {
          term: 1,
          candidateId: 'node-a',
          lastLogIndex: 0,
          lastLogTerm: 0
        }),
      /boom-from-endpoint/i
    );
  } finally {
    await transportA.stop();
    await transportB.stop();
    certs.cleanup();
  }
});

test('[unit/tls-transport] rejects forged fromNodeId in payload', { skip: !hasOpenSsl() }, async () => {
  const certs = createTestCertificates(['node-a', 'node-b']);
  const [portA] = await getFreePorts(1);

  const transportA = createTlsRaftTransport<Command>({
    nodeId: 'node-a',
    host: '127.0.0.1',
    port: portA,
    peers: [{ nodeId: 'node-b', host: '127.0.0.1', port: 9_999 }],
    tls: {
      cert: certs.nodes['node-a'].certPem,
      key: certs.nodes['node-a'].keyPem,
      ca: certs.caPem
    },
    rpcTimeoutMs: 1_000
  });

  try {
    await transportA.start(createEndpoint());

    const socket = connect({
      host: '127.0.0.1',
      port: portA,
      cert: certs.nodes['node-b'].certPem,
      key: certs.nodes['node-b'].keyPem,
      ca: certs.caPem,
      rejectUnauthorized: true,
      servername: 'node-a'
    });

    const response = await new Promise<string>((resolve, reject) => {
      let buffer = '';

      socket.once('secureConnect', () => {
        socket.write(
          `${JSON.stringify({
            id: 'forged-id',
            method: 'requestVote',
            fromNodeId: 'node-c',
            payload: {
              term: 1,
              candidateId: 'node-c',
              lastLogIndex: 0,
              lastLogTerm: 0
            }
          })}\n`
        );
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          return;
        }
        resolve(buffer.slice(0, newline));
        socket.end();
      });
      socket.once('error', reject);
    });

    const parsed = JSON.parse(response) as {
      ok: boolean;
      error?: { message: string };
    };
    assert.equal(parsed.ok, false);
    assert.match(parsed.error?.message ?? '', /Peer identity mismatch/i);
  } finally {
    await transportA.stop();
    certs.cleanup();
  }
});

test('[unit/tls-transport] upsertPeer and removePeer alter routability', { skip: !hasOpenSsl() }, async () => {
  const certs = createTestCertificates(['node-a', 'node-b']);
  const [portA, portB] = await getFreePorts(2);

  const transportA = createTlsRaftTransport<Command>({
    nodeId: 'node-a',
    host: '127.0.0.1',
    port: portA,
    peers: [],
    tls: {
      cert: certs.nodes['node-a'].certPem,
      key: certs.nodes['node-a'].keyPem,
      ca: certs.caPem
    },
    rpcTimeoutMs: 1_000
  });
  const transportB = createTlsRaftTransport<Command>({
    nodeId: 'node-b',
    host: '127.0.0.1',
    port: portB,
    peers: [{ nodeId: 'node-a', host: '127.0.0.1', port: portA }],
    tls: {
      cert: certs.nodes['node-b'].certPem,
      key: certs.nodes['node-b'].keyPem,
      ca: certs.caPem
    },
    rpcTimeoutMs: 1_000
  });

  try {
    await transportA.start(createEndpoint());
    await transportB.start(createEndpoint());

    await assert.rejects(
      () =>
        transportA.requestVote('node-a', 'node-b', {
          term: 1,
          candidateId: 'node-a',
          lastLogIndex: 0,
          lastLogTerm: 0
        }),
      /Unknown peer/i
    );

    transportA.upsertPeer?.({ nodeId: 'node-b', host: '127.0.0.1', port: portB });
    const vote = await transportA.requestVote('node-a', 'node-b', {
      term: 1,
      candidateId: 'node-a',
      lastLogIndex: 0,
      lastLogTerm: 0
    });
    assert.equal(vote.voteGranted, true);

    transportA.removePeer?.('node-b');
    await assert.rejects(
      () =>
        transportA.requestVote('node-a', 'node-b', {
          term: 2,
          candidateId: 'node-a',
          lastLogIndex: 0,
          lastLogTerm: 0
        }),
      /Unknown peer/i
    );
  } finally {
    await transportA.stop();
    await transportB.stop();
    certs.cleanup();
  }
});

test('[unit/tls-transport] request times out when peer accepts but never replies', { skip: !hasOpenSsl() }, async () => {
  const certs = createTestCertificates(['node-a', 'node-b']);
  const [portA, silentPort] = await getFreePorts(2);
  const sockets = new Set<import('node:tls').TLSSocket>();

  const silentServer = createServer(
    {
      cert: certs.nodes['node-b'].certPem,
      key: certs.nodes['node-b'].keyPem,
      ca: certs.caPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3'
    },
    (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
      // Intentionally do nothing so the client read path times out.
    }
  );

  await new Promise<void>((resolve, reject) => {
    silentServer.once('error', reject);
    silentServer.listen(silentPort, '127.0.0.1', () => resolve());
  });

  const transportA = createTlsRaftTransport<Command>({
    nodeId: 'node-a',
    host: '127.0.0.1',
    port: portA,
    peers: [{ nodeId: 'node-b', host: '127.0.0.1', port: silentPort }],
    tls: {
      cert: certs.nodes['node-a'].certPem,
      key: certs.nodes['node-a'].keyPem,
      ca: certs.caPem
    },
    rpcTimeoutMs: 50
  });

  try {
    await transportA.start(createEndpoint());
    await assert.rejects(
      () =>
        transportA.requestVote('node-a', 'node-b', {
          term: 1,
          candidateId: 'node-a',
          lastLogIndex: 0,
          lastLogTerm: 0
        }),
      /Timed out waiting for RPC response/i
    );
  } finally {
    await transportA.stop();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => silentServer.close(() => resolve()));
    certs.cleanup();
  }
});
