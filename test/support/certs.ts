import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

function runOpenSsl(args: string[], cwd: string): void {
  execFileSync('openssl', args, {
    cwd,
    stdio: 'pipe'
  });
}

export function hasOpenSsl(): boolean {
  const result = spawnSync('openssl', ['version'], { stdio: 'pipe' });
  return result.status === 0;
}

export type NodeCertificateBundle = {
  nodeId: string;
  certPem: string;
  keyPem: string;
};

export type TestCertificates = {
  caPem: string;
  nodes: Record<string, NodeCertificateBundle>;
  cleanup: () => void;
};

export function createTestCertificates(nodeIds: string[]): TestCertificates {
  const workingDir = mkdtempSync(join(tmpdir(), 'diskeyval-certs-'));

  const caKeyPath = join(workingDir, 'ca.key.pem');
  const caCertPath = join(workingDir, 'ca.cert.pem');

  runOpenSsl(['genrsa', '-out', caKeyPath, '2048'], workingDir);
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
      '1',
      '-out',
      caCertPath,
      '-subj',
      '/CN=diskeyval-test-ca'
    ],
    workingDir
  );

  const caPem = readFileSync(caCertPath, 'utf8');
  const nodes: Record<string, NodeCertificateBundle> = {};

  for (const nodeId of nodeIds) {
    const keyPath = join(workingDir, `${nodeId}.key.pem`);
    const csrPath = join(workingDir, `${nodeId}.csr.pem`);
    const certPath = join(workingDir, `${nodeId}.cert.pem`);
    const configPath = join(workingDir, `${nodeId}.cnf`);

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
      ].join('\n')
    );

    runOpenSsl(['genrsa', '-out', keyPath, '2048'], workingDir);
    runOpenSsl(
      ['req', '-new', '-key', keyPath, '-out', csrPath, '-config', configPath],
      workingDir
    );
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
        '1',
        '-sha256',
        '-extfile',
        configPath,
        '-extensions',
        'req_ext'
      ],
      workingDir
    );

    nodes[nodeId] = {
      nodeId,
      certPem: readFileSync(certPath, 'utf8'),
      keyPem: readFileSync(keyPath, 'utf8')
    };
  }

  return {
    caPem,
    nodes,
    cleanup: () => {
      rmSync(workingDir, { recursive: true, force: true });
    }
  };
}
