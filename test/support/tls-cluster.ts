import { diskeyval, type DiskeyvalNode } from '../../lib/index.ts';
import { createTestCertificates, hasOpenSsl } from './certs.ts';
import { getFreePorts } from './ports.ts';

type TlsTestCluster = {
  nodes: Record<string, DiskeyvalNode>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cleanup: () => void;
};

export async function createTlsTestCluster(
  nodeIds: string[],
  options?: {
    persistenceDir?: string;
  }
): Promise<TlsTestCluster> {
  if (!hasOpenSsl()) {
    throw new Error('openssl is required for TLS e2e tests');
  }

  const certs = createTestCertificates(nodeIds);
  const ports = await getFreePorts(nodeIds.length);

  const endpoints = nodeIds.map((nodeId, index) => ({
    nodeId,
    host: '127.0.0.1',
    port: ports[index]
  }));

  const nodes: Record<string, DiskeyvalNode> = {};

  for (const endpoint of endpoints) {
    const peers = endpoints
      .filter((candidate) => candidate.nodeId !== endpoint.nodeId)
      .map((candidate) => ({
        nodeId: candidate.nodeId,
        host: candidate.host,
        port: candidate.port
      }));

    nodes[endpoint.nodeId] = diskeyval({
      nodeId: endpoint.nodeId,
      host: endpoint.host,
      port: endpoint.port,
      peers,
      tls: {
        cert: certs.nodes[endpoint.nodeId].certPem,
        key: certs.nodes[endpoint.nodeId].keyPem,
        ca: certs.caPem
      },
      electionTimeoutMs: 200,
      heartbeatMs: 50,
      proposalTimeoutMs: 1_000,
      rpcTimeoutMs: 1_000,
      persistence:
        options?.persistenceDir !== undefined
          ? {
              dir: options.persistenceDir,
              compactEvery: 16
            }
          : undefined
    });
  }

  return {
    nodes,
    start: async () => {
      for (const nodeId of nodeIds) {
        await nodes[nodeId].start();
      }
    },
    stop: async () => {
      await Promise.all(
        nodeIds.map(async (nodeId) => {
          await nodes[nodeId].end();
        })
      );
    },
    cleanup: () => {
      certs.cleanup();
    }
  };
}
