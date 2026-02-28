import { appendFile, mkdir, readFile, rename, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RaftPersistentState, RaftStorage } from '../raft/types.ts';

type FileWalRecord<T> = {
  state: RaftPersistentState<T>;
};

export type FileRaftStorageOptions = {
  dir: string;
  nodeId: string;
  compactEvery?: number;
};

export function createFileRaftStorage<T = unknown>(options: FileRaftStorageOptions): RaftStorage<T> {
  const compactEvery = options.compactEvery ?? 64;
  const nodeDir = join(options.dir, options.nodeId);
  const snapshotPath = join(nodeDir, 'snapshot.json');
  const walPath = join(nodeDir, 'wal.ndjson');

  let saveCount = 0;

  const ensureDir = async (): Promise<void> => {
    await mkdir(nodeDir, { recursive: true });
  };

  const parseSnapshot = async (): Promise<RaftPersistentState<T> | null> => {
    try {
      const raw = await readFile(snapshotPath, 'utf8');
      return JSON.parse(raw) as RaftPersistentState<T>;
    } catch {
      return null;
    }
  };

  const parseWal = async (): Promise<RaftPersistentState<T> | null> => {
    try {
      const raw = await readFile(walPath, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);

      let latest: RaftPersistentState<T> | null = null;
      for (const line of lines) {
        const record = JSON.parse(line) as FileWalRecord<T>;
        latest = record.state;
      }

      return latest;
    } catch {
      return null;
    }
  };

  const load = async (): Promise<RaftPersistentState<T> | null> => {
    await ensureDir();

    const snapshot = await parseSnapshot();
    const walState = await parseWal();

    return walState ?? snapshot;
  };

  const compact = async (state: RaftPersistentState<T>): Promise<void> => {
    const tmpPath = `${snapshotPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state), 'utf8');
    await rename(tmpPath, snapshotPath);
    await truncate(walPath, 0);
  };

  const save = async (state: RaftPersistentState<T>): Promise<void> => {
    await ensureDir();
    const record: FileWalRecord<T> = { state };
    await appendFile(walPath, `${JSON.stringify(record)}\n`, 'utf8');

    saveCount += 1;
    if (saveCount % compactEvery === 0) {
      await compact(state);
    }
  };

  return {
    load,
    save
  };
}
