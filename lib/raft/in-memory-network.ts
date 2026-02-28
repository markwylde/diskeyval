import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  ManagedRaftTransport,
  RaftRpcEndpoint,
  RequestVoteRequest,
  RequestVoteResponse
} from './types.ts';

function directedEdge(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}->${toNodeId}`;
}

export type InMemoryRaftNetwork<T = unknown> = ManagedRaftTransport<T> & {
  register: (nodeId: string, endpoint: RaftRpcEndpoint<T>) => void;
  unregister: (nodeId: string) => void;
  partition: (nodeA: string, nodeB: string) => void;
  heal: (nodeA: string, nodeB: string) => void;
  healAll: () => void;
};

export function createInMemoryRaftNetwork<T = unknown>(options?: {
  latencyMs?: number;
}): InMemoryRaftNetwork<T> {
  const endpoints = new Map<string, RaftRpcEndpoint<T>>();
  const blockedEdges = new Set<string>();
  const latencyMs = options?.latencyMs ?? 0;

  const waitLatency = async (): Promise<void> => {
    if (latencyMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, latencyMs));
  };

  const assertReachable = (fromNodeId: string, toNodeId: string): void => {
    if (!blockedEdges.has(directedEdge(fromNodeId, toNodeId))) {
      return;
    }
    throw new Error(`Network partition between ${fromNodeId} and ${toNodeId}`);
  };

  const requestVote = async (
    fromNodeId: string,
    toNodeId: string,
    request: RequestVoteRequest
  ): Promise<RequestVoteResponse> => {
    await waitLatency();
    assertReachable(fromNodeId, toNodeId);

    const endpoint = endpoints.get(toNodeId);
    if (!endpoint) {
      throw new Error(`Unknown node: ${toNodeId}`);
    }

    return endpoint.onRequestVote(fromNodeId, request);
  };

  const appendEntries = async (
    fromNodeId: string,
    toNodeId: string,
    request: AppendEntriesRequest<T>
  ): Promise<AppendEntriesResponse> => {
    await waitLatency();
    assertReachable(fromNodeId, toNodeId);

    const endpoint = endpoints.get(toNodeId);
    if (!endpoint) {
      throw new Error(`Unknown node: ${toNodeId}`);
    }

    return endpoint.onAppendEntries(fromNodeId, request);
  };

  return {
    requestVote,
    appendEntries,
    register: (nodeId: string, endpoint: RaftRpcEndpoint<T>): void => {
      endpoints.set(nodeId, endpoint);
    },
    unregister: (nodeId: string): void => {
      endpoints.delete(nodeId);
    },
    partition: (nodeA: string, nodeB: string): void => {
      blockedEdges.add(directedEdge(nodeA, nodeB));
      blockedEdges.add(directedEdge(nodeB, nodeA));
    },
    heal: (nodeA: string, nodeB: string): void => {
      blockedEdges.delete(directedEdge(nodeA, nodeB));
      blockedEdges.delete(directedEdge(nodeB, nodeA));
    },
    healAll: (): void => {
      blockedEdges.clear();
    }
  };
}
