import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { __tlsTransportInternals } from '../../lib/raft/tls-transport.ts';

type MockSocket = EventEmitter & {
  authorized: boolean;
  authorizationError?: Error;
  peerCertificate: Record<string, unknown>;
  writes: string[];
  ended: boolean;
  destroyed: boolean;
  getPeerCertificate: (_detailed?: boolean) => Record<string, unknown>;
  write: (chunk: string) => void;
  end: () => void;
  destroy: () => void;
  off: (eventName: string, listener: (...args: unknown[]) => void) => MockSocket;
  on: (eventName: string, listener: (...args: unknown[]) => void) => MockSocket;
  once: (eventName: string, listener: (...args: unknown[]) => void) => MockSocket;
};

function createMockSocket(options?: {
  authorized?: boolean;
  authorizationError?: Error;
  peerCertificate?: Record<string, unknown>;
  writeThrows?: boolean;
}): MockSocket {
  const emitter = new EventEmitter() as MockSocket;
  emitter.authorized = options?.authorized ?? true;
  emitter.authorizationError = options?.authorizationError;
  emitter.peerCertificate = options?.peerCertificate ?? {
    subject: { CN: 'node-a' },
    subjectaltname: 'URI:spiffe://diskeyval/node-a,DNS:node-a'
  };
  emitter.writes = [];
  emitter.ended = false;
  emitter.destroyed = false;
  emitter.getPeerCertificate = () => emitter.peerCertificate;
  emitter.write = (chunk: string) => {
    if (options?.writeThrows) {
      throw new Error('write failed');
    }
    emitter.writes.push(chunk);
  };
  emitter.end = () => {
    emitter.ended = true;
  };
  emitter.destroy = () => {
    emitter.destroyed = true;
  };
  return emitter;
}

test('[unit/tls-internals] parseNodeIdFromCertificate covers CN, URI, DNS and null', () => {
  const fromCn = __tlsTransportInternals.parseNodeIdFromCertificate({
    subject: { CN: 'node-cn' }
  } as never);
  assert.equal(fromCn, 'node-cn');

  const fromUri = __tlsTransportInternals.parseNodeIdFromCertificate({
    subject: {},
    subjectaltname: 'URI:spiffe://diskeyval/node-uri'
  } as never);
  assert.equal(fromUri, 'node-uri');

  const fromDns = __tlsTransportInternals.parseNodeIdFromCertificate({
    subject: {},
    subjectaltname: 'DNS:node-dns'
  } as never);
  assert.equal(fromDns, 'node-dns');

  const none = __tlsTransportInternals.parseNodeIdFromCertificate({
    subject: {},
    subjectaltname: 'DNS:'
  } as never);
  assert.equal(none, null);
});

test('[unit/tls-internals] assertCertificateNodeId mismatch throws', () => {
  assert.throws(
    () =>
      __tlsTransportInternals.assertCertificateNodeId(
        {
          subject: { CN: 'node-a' }
        } as never,
        'node-b'
      ),
    /Peer certificate identity mismatch/i
  );
});

test('[unit/tls-internals] readSingleLine handles newline, error, and end branches', async () => {
  const socketOk = createMockSocket();
  const okPromise = __tlsTransportInternals.readSingleLine(socketOk as never, 200);
  socketOk.emit('data', Buffer.from('partial'));
  socketOk.emit('data', Buffer.from('-line\ntrailing'));
  const line = await okPromise;
  assert.equal(line, 'partial-line');

  const socketErr = createMockSocket();
  const errPromise = __tlsTransportInternals.readSingleLine(socketErr as never, 200);
  socketErr.emit('error', new Error('boom'));
  await assert.rejects(() => errPromise, /boom/i);

  const socketEnd = createMockSocket();
  const endPromise = __tlsTransportInternals.readSingleLine(socketEnd as never, 200);
  socketEnd.emit('end');
  await assert.rejects(
    () => endPromise,
    /Socket ended before newline-terminated message was received/i
  );
});

test('[unit/tls-internals] withTimeout rejection path is covered', async () => {
  await assert.rejects(
    () =>
      __tlsTransportInternals.withTimeout(
        new Promise<void>(() => undefined),
        10,
        'timed out internal'
      ),
    /timed out internal/i
  );
});

test('[unit/tls-internals] handleIncomingSocket covers endpoint/cert/auth/error branches', async () => {
  const endpoint = {
    onRequestVote: async () => ({ term: 1, voteGranted: true }),
    onAppendEntries: async () => ({ term: 1, success: true, matchIndex: 0 })
  };

  const baseContext = {
    nodeId: 'node-a',
    host: '127.0.0.1',
    port: 6000,
    peers: new Map(),
    cert: '',
    key: '',
    ca: '',
    minVersion: 'TLSv1.3',
    rpcTimeoutMs: 200,
    endpoint,
    server: null
  };

  const endpointMissingSocket = createMockSocket();
  await __tlsTransportInternals.handleIncomingSocket(
    { ...baseContext, endpoint: null } as never,
    endpointMissingSocket as never
  );
  assert.equal(endpointMissingSocket.destroyed, true);

  const unauthorizedSocket = createMockSocket({
    authorized: false,
    authorizationError: new Error('unauthorized')
  });
  await __tlsTransportInternals.handleIncomingSocket(baseContext as never, unauthorizedSocket as never);
  assert.equal(unauthorizedSocket.destroyed, true);

  const noCertSocket = createMockSocket({
    peerCertificate: {}
  });
  await __tlsTransportInternals.handleIncomingSocket(baseContext as never, noCertSocket as never);
  assert.equal(noCertSocket.destroyed, true);

  const noIdentitySocket = createMockSocket({
    peerCertificate: {
      subject: {},
      subjectaltname: 'IP:127.0.0.1'
    }
  });
  await __tlsTransportInternals.handleIncomingSocket(baseContext as never, noIdentitySocket as never);
  assert.equal(noIdentitySocket.destroyed, true);

  const payloadMismatchSocket = createMockSocket({
    peerCertificate: {
      subject: { CN: 'node-a' }
    }
  });
  const mismatchPromise = __tlsTransportInternals.handleIncomingSocket(
    baseContext as never,
    payloadMismatchSocket as never
  );
  payloadMismatchSocket.emit(
    'data',
    Buffer.from(
      `${JSON.stringify({
        id: '1',
        method: 'requestVote',
        fromNodeId: 'node-z',
        payload: {
          term: 1,
          candidateId: 'node-z',
          lastLogIndex: 0,
          lastLogTerm: 0
        }
      })}\n`
    )
  );
  await mismatchPromise;
  assert.equal(payloadMismatchSocket.destroyed, true);

  const writeFailSocket = createMockSocket({
    writeThrows: true
  });
  await __tlsTransportInternals.handleIncomingSocket(baseContext as never, writeFailSocket as never);
  assert.equal(writeFailSocket.destroyed, true);
});

