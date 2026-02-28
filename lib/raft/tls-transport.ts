import {
  connect,
  createServer,
  type DetailedPeerCertificate,
  type TLSSocket,
  type TlsOptions
} from 'node:tls';
import { randomUUID } from 'node:crypto';
import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  ManagedRaftTransport,
  RaftRpcEndpoint,
  RequestVoteRequest,
  RequestVoteResponse
} from './types.ts';

type RpcMethod = 'requestVote' | 'appendEntries';

type RpcRequest<T> = {
  id: string;
  method: RpcMethod;
  fromNodeId: string;
  payload: RequestVoteRequest | AppendEntriesRequest<T>;
};

type RpcSuccessResponse = {
  id: string;
  ok: true;
  result: RequestVoteResponse | AppendEntriesResponse;
};

type RpcErrorResponse = {
  id: string;
  ok: false;
  error: {
    name: string;
    message: string;
  };
};

type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export type TlsPeer = {
  nodeId: string;
  host: string;
  port: number;
};

export type TlsRaftTransportOptions = {
  nodeId: string;
  host: string;
  port: number;
  peers: TlsPeer[];
  tls: {
    cert: string;
    key: string;
    ca: string;
    servername?: string;
    minVersion?: TlsOptions['minVersion'];
  };
  rpcTimeoutMs?: number;
};

type TlsTransportContext<T> = {
  nodeId: string;
  host: string;
  port: number;
  peers: Map<string, TlsPeer>;
  cert: string;
  key: string;
  ca: string;
  minVersion: TlsOptions['minVersion'];
  rpcTimeoutMs: number;
  endpoint: RaftRpcEndpoint<T> | null;
  server: ReturnType<typeof createServer> | null;
};

function parseNodeIdFromCertificate(cert: DetailedPeerCertificate): string | null {
  const commonName = cert.subject?.CN;
  if (commonName) {
    return commonName;
  }

  const subjectAltName = cert.subjectaltname ?? '';
  const uriMatch = subjectAltName.match(/URI:spiffe:\/\/diskeyval\/([^,]+)/);
  if (uriMatch) {
    return uriMatch[1];
  }

  const dnsMatch = subjectAltName.match(/DNS:([^,]+)/);
  if (dnsMatch) {
    return dnsMatch[1];
  }

  return null;
}

function assertCertificateNodeId(cert: DetailedPeerCertificate, expectedNodeId: string): void {
  const certNodeId = parseNodeIdFromCertificate(cert);
  if (certNodeId !== expectedNodeId) {
    throw new Error(
      `Peer certificate identity mismatch: expected ${expectedNodeId}, received ${certNodeId ?? 'unknown'}`
    );
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function serializeMessage(message: RpcRequest<unknown> | RpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

function parseMessage<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function readSingleLine(socket: TLSSocket, timeoutMs: number): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      let buffer = '';

      const cleanup = (): void => {
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('end', onEnd);
      };

      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) {
          return;
        }

        const line = buffer.slice(0, newlineIndex);
        cleanup();
        resolve(line);
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const onEnd = (): void => {
        cleanup();
        reject(new Error('Socket ended before newline-terminated message was received'));
      };

      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('end', onEnd);
    }),
    timeoutMs,
    `Timed out waiting for RPC response after ${timeoutMs}ms`
  );
}

async function connectToPeer<T>(context: TlsTransportContext<T>, peer: TlsPeer): Promise<TLSSocket> {
  return withTimeout(
    new Promise<TLSSocket>((resolve, reject) => {
      const socket = connect({
        host: peer.host,
        port: peer.port,
        cert: context.cert,
        key: context.key,
    ca: context.ca,
    rejectUnauthorized: true,
    minVersion: context.minVersion,
    servername: peer.nodeId
      });

      const cleanup = (): void => {
        socket.off('error', onError);
        socket.off('secureConnect', onSecureConnect);
      };

      const onError = (error: Error): void => {
        cleanup();
        socket.destroy();
        reject(error);
      };

      const onSecureConnect = (): void => {
        try {
          if (!socket.authorized) {
            throw socket.authorizationError ?? new Error('TLS socket is not authorized');
          }

          const certificate = socket.getPeerCertificate(true);
          if (!certificate || Object.keys(certificate).length === 0) {
            throw new Error('Peer did not provide a certificate');
          }

          assertCertificateNodeId(certificate as DetailedPeerCertificate, peer.nodeId);
          cleanup();
          resolve(socket);
        } catch (error) {
          cleanup();
          socket.destroy();
          reject(error);
        }
      };

      socket.once('secureConnect', onSecureConnect);
      socket.once('error', onError);
    }),
    context.rpcTimeoutMs,
    `Timed out connecting to peer ${peer.nodeId} after ${context.rpcTimeoutMs}ms`
  );
}

async function sendRpc<T>(
  context: TlsTransportContext<T>,
  fromNodeId: string,
  toNodeId: string,
  method: RpcMethod,
  payload: RequestVoteRequest | AppendEntriesRequest<T>
): Promise<RequestVoteResponse | AppendEntriesResponse> {
  const peer = context.peers.get(toNodeId);
  if (!peer) {
    throw new Error(`Unknown peer ${toNodeId}`);
  }

  const socket = await connectToPeer(context, peer);

  try {
    const request: RpcRequest<T> = {
      id: randomUUID(),
      method,
      fromNodeId,
      payload
    };

    socket.write(serializeMessage(request));
    const rawResponse = await readSingleLine(socket, context.rpcTimeoutMs);
    const response = parseMessage<RpcResponse>(rawResponse);

    if (!response.ok) {
      throw new Error(`${response.error.name}: ${response.error.message}`);
    }

    return response.result;
  } finally {
    socket.end();
    socket.destroy();
  }
}

async function handleIncomingSocket<T>(context: TlsTransportContext<T>, socket: TLSSocket): Promise<void> {
  try {
    if (!context.endpoint) {
      throw new Error('RPC endpoint is not attached');
    }

    if (!socket.authorized) {
      throw socket.authorizationError ?? new Error('Unauthorized peer certificate');
    }

    const certificate = socket.getPeerCertificate(true);
    if (!certificate || Object.keys(certificate).length === 0) {
      throw new Error('Peer did not provide a certificate');
    }

    const certNodeId = parseNodeIdFromCertificate(certificate as DetailedPeerCertificate);
    if (!certNodeId) {
      throw new Error('Unable to determine peer identity from certificate');
    }

    const requestRaw = await readSingleLine(socket, context.rpcTimeoutMs);
    const request = parseMessage<RpcRequest<T>>(requestRaw);

    if (request.fromNodeId !== certNodeId) {
      throw new Error(`Peer identity mismatch: cert=${certNodeId}, payload=${request.fromNodeId}`);
    }

    let result: RequestVoteResponse | AppendEntriesResponse;

    if (request.method === 'requestVote') {
      result = await context.endpoint.onRequestVote(
        request.fromNodeId,
        request.payload as RequestVoteRequest
      );
    } else {
      result = await context.endpoint.onAppendEntries(
        request.fromNodeId,
        request.payload as AppendEntriesRequest<T>
      );
    }

    const response: RpcSuccessResponse = {
      id: request.id,
      ok: true,
      result
    };

    socket.write(serializeMessage(response));
    socket.end();
  } catch (error) {
    const errorResponse: RpcErrorResponse = {
      id: randomUUID(),
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error)
      }
    };

    try {
      socket.write(serializeMessage(errorResponse));
    } catch {
      // Ignore secondary transport errors.
    }

    socket.destroy();
  }
}

export const __tlsTransportInternals = {
  parseNodeIdFromCertificate,
  assertCertificateNodeId,
  withTimeout,
  readSingleLine,
  handleIncomingSocket
};

export function createTlsRaftTransport<T = unknown>(
  options: TlsRaftTransportOptions
): ManagedRaftTransport<T> {
  const context: TlsTransportContext<T> = {
    nodeId: options.nodeId,
    host: options.host,
    port: options.port,
    peers: new Map(options.peers.map((peer) => [peer.nodeId, peer])),
    cert: options.tls.cert,
    key: options.tls.key,
    ca: options.tls.ca,
    minVersion: options.tls.minVersion ?? 'TLSv1.3',
    rpcTimeoutMs: options.rpcTimeoutMs ?? 3_000,
    endpoint: null,
    server: null
  };

  const start = async (endpoint: RaftRpcEndpoint<T>): Promise<void> => {
    if (context.server) {
      return;
    }

    context.endpoint = endpoint;
    context.server = createServer(
      {
        cert: context.cert,
        key: context.key,
        ca: context.ca,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: context.minVersion
      },
      (socket) => {
        void handleIncomingSocket(context, socket);
      }
    );

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        if (!context.server) {
          reject(new Error('TLS server was not initialized'));
          return;
        }

        context.server.once('error', reject);
        context.server.listen(context.port, context.host, () => {
          context.server?.off('error', reject);
          resolve();
        });
      }),
      context.rpcTimeoutMs,
      `Timed out starting TLS transport listener after ${context.rpcTimeoutMs}ms`
    );
  };

  const stop = async (): Promise<void> => {
    if (!context.server) {
      return;
    }

    const serverToClose = context.server;
    context.server = null;
    context.endpoint = null;

    await new Promise<void>((resolve, reject) => {
      serverToClose.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  const requestVote = async (
    fromNodeId: string,
    toNodeId: string,
    request: RequestVoteRequest
  ): Promise<RequestVoteResponse> => {
    return sendRpc(context, fromNodeId, toNodeId, 'requestVote', request) as Promise<RequestVoteResponse>;
  };

  const appendEntries = async (
    fromNodeId: string,
    toNodeId: string,
    request: AppendEntriesRequest<T>
  ): Promise<AppendEntriesResponse> => {
    return sendRpc(context, fromNodeId, toNodeId, 'appendEntries', request) as Promise<AppendEntriesResponse>;
  };

  return {
    start,
    stop,
    requestVote,
    appendEntries,
    upsertPeer: (peer) => {
      context.peers.set(peer.nodeId, {
        nodeId: peer.nodeId,
        host: peer.host,
        port: peer.port
      });
    },
    removePeer: (nodeId: string) => {
      context.peers.delete(nodeId);
    }
  };
}
