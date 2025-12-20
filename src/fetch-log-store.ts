import { Plugin } from 'obsidian';

export interface FetchLogEntry {
  fetchedAt: string;
  filename?: string;
}

export type FetchLog = Record<string, FetchLogEntry>;

export interface FetchLogInput {
  id: number | string;
  filename?: string;
  fetchedAt?: string;
}

const FETCH_LOG_KEY = 'fetch-log';

export async function loadFetchLog(plugin: Plugin): Promise<FetchLog> {
  try {
    const raw = await plugin.loadData();
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    const envelope = raw as Record<string, unknown>;
    const stored = envelope[FETCH_LOG_KEY];
    if (!stored || typeof stored !== 'object') {
      return {};
    }
    const parsed = stored as Record<string, unknown>;
    const log: FetchLog = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Record<string, unknown>;
      if (typeof entry.fetchedAt === 'string') {
        log[key] = {
          fetchedAt: entry.fetchedAt,
          filename:
            typeof entry.filename === 'string' && entry.filename.length > 0
              ? entry.filename
              : undefined,
        };
      }
    }
    return log;
  } catch (error) {
    console.warn(
      `[Email2Obsidian] Failed to load fetch log via plugin data: ${(error as Error).message}`
    );
    return {};
  }
}

export async function writeFetchLog(
  plugin: Plugin,
  log: FetchLog
): Promise<void> {
  const existing = await plugin.loadData();
  const payload = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    [FETCH_LOG_KEY]: log,
  };
  await plugin.saveData(payload);
}

export function appendFetchLog(
  current: FetchLog,
  entries: FetchLogInput[],
  clock: () => string = () => new Date().toISOString()
): FetchLog {
  const next: FetchLog = { ...current };
  for (const entry of entries) {
    const key = String(entry.id);
    next[key] = {
      fetchedAt: entry.fetchedAt ?? clock(),
      filename: entry.filename,
    };
  }
  return next;
}

export function rewriteFetchLog(
  entries: FetchLogInput[],
  clock: () => string = () => new Date().toISOString()
): FetchLog {
  const next: FetchLog = {};
  for (const entry of entries) {
    const key = String(entry.id);
    next[key] = {
      fetchedAt: entry.fetchedAt ?? clock(),
      filename: entry.filename,
    };
  }
  return next;
}
