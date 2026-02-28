import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import diskeyval, { isNotLeaderError, type ClusterPeer } from './lib/index.ts';

type CliOptions = {
  port: number;
  connectPorts: number[];
  host: string;
};

type SetGetRequest = {
  op: 'set' | 'get';
  key: string;
  value?: unknown;
};

type JoinRequest = {
  op: 'join';
  peer: {
    nodeId: string;
    host: string;
    port: number;
  };
};

type CommandRequest = SetGetRequest | JoinRequest;

type CommandResponse = {
  ok: boolean;
  value?: unknown;
  error?: string;
  leaderId?: string | null;
};

function parseArgs(argv: string[]): CliOptions {
  let port: number | null = null;
  const connectPorts: number[] = [];
  let host = '127.0.0.1';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--port') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --port');
      }
      port = Number(value);
      index += 1;
      continue;
    }

    if (arg === '--connect') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --connect');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --connect port: ${value}`);
      }
      connectPorts.push(parsed);
      index += 1;
      continue;
    }

    if (arg === '--host') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --host');
      }
      host = value;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!port || !Number.isInteger(port) || port <= 0) {
    throw new Error('You must provide a valid --port <number>');
  }

  return { port, connectPorts, host };
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  node example.ts --port 6001');
  console.log('  node example.ts --port 6002 --connect 6001');
  console.log('  node example.ts --port 6003 --connect 6002   # dynamic join');
  console.log('');
  console.log('Optional flags:');
  console.log('  --host 127.0.0.1');
}

function ensureOpenSsl(): void {
  const check = spawnSync('openssl', ['version'], { stdio: 'pipe' });
  if (check.status !== 0) {
    throw new Error('openssl is required for example.ts (not found in PATH)');
  }
}

function runOpenSsl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

function ensureCa(baseDir: string): { caKeyPath: string; caCertPath: string } {
  const caKeyPath = join(baseDir, 'ca.key.pem');
  const caCertPath = join(baseDir, 'ca.cert.pem');

  if (existsSync(caKeyPath) && existsSync(caCertPath)) {
    return { caKeyPath, caCertPath };
  }

  runOpenSsl(['genrsa', '-out', caKeyPath, '2048'], baseDir);
  runOpenSsl(
    [
      'req',
      '-x509',
      '-new',
      '-nodes',
      '-key',
      caKeyPath,
      '-sha256',
      '-days',
      '365',
      '-out',
      caCertPath,
      '-subj',
      '/CN=diskeyval-example-ca'
    ],
    baseDir
  );

  return { caKeyPath, caCertPath };
}

function ensureNodeCert(
  baseDir: string,
  caKeyPath: string,
  caCertPath: string,
  nodeId: string
): { certPem: string; keyPem: string; caPem: string } {
  const nodeDir = join(baseDir, nodeId);
  mkdirSync(nodeDir, { recursive: true });

  const keyPath = join(nodeDir, 'node.key.pem');
  const csrPath = join(nodeDir, 'node.csr.pem');
  const certPath = join(nodeDir, 'node.cert.pem');
  const configPath = join(nodeDir, 'openssl.cnf');

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    writeFileSync(
      configPath,
      [
        '[req]',
        'prompt = no',
        'distinguished_name = dn',
        'req_extensions = req_ext',
        '',
        '[dn]',
        `CN = ${nodeId}`,
        '',
        '[req_ext]',
        `subjectAltName = DNS:${nodeId},URI:spiffe://diskeyval/${nodeId}`,
        'extendedKeyUsage = serverAuth,clientAuth',
        'keyUsage = digitalSignature,keyEncipherment'
      ].join('\n'),
      'utf8'
    );

    runOpenSsl(['genrsa', '-out', keyPath, '2048'], nodeDir);
    runOpenSsl(['req', '-new', '-key', keyPath, '-out', csrPath, '-config', configPath], nodeDir);
    runOpenSsl(
      [
        'x509',
        '-req',
        '-in',
        csrPath,
        '-CA',
        caCertPath,
        '-CAkey',
        caKeyPath,
        '-CAcreateserial',
        '-out',
        certPath,
        '-days',
        '365',
        '-sha256',
        '-extfile',
        configPath,
        '-extensions',
        'req_ext'
      ],
      nodeDir
    );
  }

  return {
    certPem: readFileSync(certPath, 'utf8'),
    keyPem: readFileSync(keyPath, 'utf8'),
    caPem: readFileSync(caCertPath, 'utf8')
  };
}

function leaderPortFromNodeId(nodeId: string | null): number | null {
  if (!nodeId) {
    return null;
  }
  const match = /^node-(\d+)$/.exec(nodeId);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

async function sendControlRequest(
  host: string,
  port: number,
  request: CommandRequest
): Promise<CommandResponse> {
  return new Promise<CommandResponse>((resolve, reject) => {
    const socket = net.createConnection({ host, port: port + 10000 }, () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }

      const line = buffer.slice(0, newline);
      socket.end();

      try {
        resolve(JSON.parse(line) as CommandResponse);
      } catch (error) {
        reject(error);
      }
    });

    socket.on('error', (error) => {
      reject(error);
    });

    socket.on('end', () => {
      if (buffer.includes('\n')) {
        return;
      }
      reject(new Error('control connection closed without response'));
    });
  });
}

function mergedPeers(current: ClusterPeer[], incoming: ClusterPeer): ClusterPeer[] {
  const next = new Map<string, ClusterPeer>();
  for (const peer of current) {
    next.set(peer.nodeId, peer);
  }
  next.set(incoming.nodeId, incoming);
  return Array.from(next.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    ensureOpenSsl();

    const projectDir = process.cwd();
    const runtimeDir = join(projectDir, '.diskeyval-example');
    const certsDir = join(runtimeDir, 'certs');
    const dataDir = join(runtimeDir, 'data');
    mkdirSync(certsDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const nodeId = `node-${options.port}`;
    const { caKeyPath, caCertPath } = ensureCa(certsDir);
    const tlsMaterial = ensureNodeCert(certsDir, caKeyPath, caCertPath, nodeId);

    const peers = options.connectPorts.map((connectPort) => ({
      nodeId: `node-${connectPort}`,
      host: options.host,
      port: connectPort
    }));

    const node = diskeyval({
      nodeId,
      host: options.host,
      port: options.port,
      peers,
      tls: {
        cert: tlsMaterial.certPem,
        key: tlsMaterial.keyPem,
        ca: tlsMaterial.caPem
      },
      persistence: {
        dir: dataDir,
        compactEvery: 16
      },
      electionTimeoutMs: 300,
      heartbeatMs: 80,
      proposalTimeoutMs: 2_000,
      rpcTimeoutMs: 2_000
    });

    node.on('leader', ({ nodeId: leaderId }) => {
      console.log(`[leader] ${leaderId ?? 'none'}`);
    });

    node.on('change', ({ key, value }) => {
      console.log(`[change] ${key}=${JSON.stringify(value)}`);
    });

    await node.start();

    const executeLocally = async (request: CommandRequest): Promise<CommandResponse> => {
      try {
        if (request.op === 'set') {
          await node.set(request.key, request.value);
          return { ok: true };
        }

        if (request.op === 'get') {
          const value = await node.get(request.key);
          return { ok: true, value };
        }

        const leaderId = node.leaderId();
        if (!node.isLeader()) {
          return {
            ok: false,
            error: 'not leader',
            leaderId
          };
        }

        const currentPeers = node.getPeers();
        await node.reconfigure(mergedPeers(currentPeers, request.peer));
        return { ok: true };
      } catch (error) {
        if (isNotLeaderError(error)) {
          return {
            ok: false,
            error: 'not leader',
            leaderId: error.leaderId
          };
        }

        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    };

    const executeWithForwarding = async (request: CommandRequest): Promise<CommandResponse> => {
      let attemptedLeaderPort: number | null = null;
      let discoveredLeaderPort: number | null = null;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const local = await executeLocally(request);
        if (local.ok) {
          return local;
        }

        if (local.error !== 'not leader') {
          return local;
        }

        const candidatePorts = new Set<number>();

        const hintedLeader = leaderPortFromNodeId(local.leaderId ?? node.leaderId());
        if (hintedLeader && hintedLeader !== options.port) {
          candidatePorts.add(hintedLeader);
        }
        if (discoveredLeaderPort && discoveredLeaderPort !== options.port) {
          candidatePorts.add(discoveredLeaderPort);
        }

        for (const connectPort of options.connectPorts) {
          if (connectPort !== options.port) {
            candidatePorts.add(connectPort);
          }
        }

        if (candidatePorts.size === 0) {
          return local;
        }

        let sawNetworkError: string | null = null;

        for (const candidatePort of candidatePorts) {
          if (candidatePort === attemptedLeaderPort) {
            continue;
          }
          attemptedLeaderPort = candidatePort;

          try {
            const forwarded = await sendControlRequest(options.host, candidatePort, request);
            if (forwarded.ok) {
              return forwarded;
            }

            if (forwarded.error === 'not leader') {
              const forwardedLeader = leaderPortFromNodeId(forwarded.leaderId ?? null);
              if (forwardedLeader && forwardedLeader !== options.port) {
                discoveredLeaderPort = forwardedLeader;
              }
              continue;
            }

            return forwarded;
          } catch (error) {
            sawNetworkError = error instanceof Error ? error.message : String(error);
          }
        }

        if (sawNetworkError) {
          return {
            ok: false,
            error: sawNetworkError
          };
        }
      }

      return {
        ok: false,
        error: 'unable to forward request to leader'
      };
    };

    const controlServer = net.createServer((socket) => {
      let buffer = '';

      socket.on('data', async (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          return;
        }

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        let request: CommandRequest;
        try {
          request = JSON.parse(line) as CommandRequest;
        } catch {
          socket.write(`${JSON.stringify({ ok: false, error: 'invalid request json' })}\n`);
          socket.end();
          return;
        }

        const response = await executeWithForwarding(request);
        socket.write(`${JSON.stringify(response)}\n`);
        socket.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(options.port + 10000, options.host, () => {
        controlServer.off('error', reject);
        resolve();
      });
    });

    console.log(`node ${nodeId} listening on ${options.host}:${options.port}`);
    if (peers.length > 0) {
      console.log(
        `configured peers: ${peers.map((peer) => `${peer.nodeId}@${peer.host}:${peer.port}`).join(', ')}`
      );
    } else {
      console.log('configured peers: none');
    }

    if (peers.length === 0) {
      await node.forceElection();
    }

    let stopJoinLoop = false;
    const joinTask =
      options.connectPorts.length > 0
        ? (async () => {
            let joined = false;
            let attempt = 0;
            let backoffMs = 250;
            let lastJoinError = 'failed to join cluster';

            while (!stopJoinLoop && !joined) {
              attempt += 1;
              const joinResponse = await executeWithForwarding({
                op: 'join',
                peer: {
                  nodeId,
                  host: options.host,
                  port: options.port
                }
              });

              if (joinResponse.ok) {
                joined = true;
                console.log('[join] cluster membership updated');
                break;
              }

              lastJoinError = joinResponse.error ?? lastJoinError;
              if (attempt === 1 || attempt % 10 === 0) {
                console.log(`[join] waiting for leader/configuration (${lastJoinError})`);
              }

              await sleep(backoffMs);
              backoffMs = Math.min(2_000, Math.floor(backoffMs * 1.5));
            }
          })()
        : Promise.resolve();

    console.log('commands: set <key> <json>, get <key>, getlocal <key>, state, peers, leader, metrics, help, quit');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    const shutdown = async (): Promise<void> => {
      stopJoinLoop = true;
      rl.close();
      await joinTask;
      await new Promise<void>((resolve) => controlServer.close(() => resolve()));
      await node.end();
      process.exit(0);
    };

    process.on('SIGINT', () => {
      void shutdown();
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        if (trimmed === 'quit' || trimmed === 'exit') {
          await shutdown();
          return;
        }

        if (trimmed === 'help') {
          console.log('set <key> <json>');
          console.log('get <key>');
          console.log('getlocal <key>');
          console.log('state');
          console.log('peers');
          console.log('leader');
          console.log('metrics');
          console.log('quit');
          return;
        }

        if (trimmed === 'state') {
          console.log(JSON.stringify(node.state, null, 2));
          return;
        }

        if (trimmed === 'peers') {
          console.log(JSON.stringify(node.getPeers(), null, 2));
          return;
        }

        if (trimmed === 'leader') {
          console.log(node.leaderId() ?? 'none');
          return;
        }

        if (trimmed === 'metrics') {
          console.log(JSON.stringify(node.getMetrics(), null, 2));
          return;
        }

        if (trimmed.startsWith('set ')) {
          const [_, key, ...valueParts] = trimmed.split(' ');
          const raw = valueParts.join(' ').trim();
          if (!key || !raw) {
            console.log('usage: set <key> <json>');
            return;
          }

          const value = JSON.parse(raw);
          const response = await executeWithForwarding({ op: 'set', key, value });
          if (!response.ok) {
            if (response.error === 'not leader') {
              console.log(`not leader (leader: ${response.leaderId ?? 'unknown'})`);
            } else {
              console.log(response.error ?? 'set failed');
            }
            return;
          }

          console.log('ok');
          return;
        }

        if (trimmed.startsWith('get ')) {
          const [_, key] = trimmed.split(' ');
          if (!key) {
            console.log('usage: get <key>');
            return;
          }

          const response = await executeWithForwarding({ op: 'get', key });
          if (!response.ok) {
            if (response.error === 'not leader') {
              console.log(`not leader (leader: ${response.leaderId ?? 'unknown'})`);
            } else {
              console.log(response.error ?? 'get failed');
            }
            return;
          }

          console.log(JSON.stringify(response.value));
          return;
        }

        if (trimmed.startsWith('getlocal ')) {
          const [_, key] = trimmed.split(' ');
          if (!key) {
            console.log('usage: getlocal <key>');
            return;
          }

          console.log(JSON.stringify(node.state[key]));
          return;
        }

        console.log(`unknown command: ${trimmed}`);
      } catch (error) {
        if (error instanceof SyntaxError) {
          console.log('invalid json value for set command');
          return;
        }

        console.error(error instanceof Error ? error.message : String(error));
      }
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exit(1);
  }
}

void main();
