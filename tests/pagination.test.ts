import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { runSync, SyncMode } from '../src/pipeline';
import { loadFetchLog } from '../src/fetch-log-store';
import type { Plugin as ObsidianPlugin, Vault as ObsidianVault } from 'obsidian';
import { Vault, Plugin, App } from './obsidian-fakes';
import { mockListEmails, mockGetEmail, resetApiMocks } from './api-mock';

vi.mock('../src/api', async () => (await import('./api-mock')).apiMock());

function summary(id: number) {
  return { id, subject: `Email ${id}`, createdAt: '2021', hashtags: null };
}

function detail(id: number) {
  return { ...summary(id), markdownBody: 'Body', attachments: [] };
}

interface SyncHarness {
  plugin: Plugin;
  run: (notifier?: (msg: string) => void) => ReturnType<typeof runSync>;
}

function harness(mode: SyncMode = 'fetch-new'): SyncHarness {
  const vault = new Vault();
  const plugin = new Plugin(new App(vault));
  return {
    plugin,
    run: (notifier: (msg: string) => void = () => {}) =>
      runSync(
        {
          mode,
          settings: { apiKey: 'k', notesFolder: 'Notes' },
          vault: vault as unknown as ObsidianVault,
          plugin: plugin as unknown as ObsidianPlugin,
        },
        notifier
      ),
  };
}

function sync(notifier?: (msg: string) => void) {
  return harness().run(notifier);
}

/**
 * A server that always promises another page and never says how to reach it.
 * The call cap turns a regression into a fast failure rather than a hung CI
 * job; `calls` is returned so a test can assert the walk really stopped.
 */
function cursorlessServer(cap = 50) {
  const counter = { calls: 0 };
  mockListEmails.mockImplementation(() => {
    counter.calls += 1;
    if (counter.calls > cap) throw new Error('paginateEmails looped on page 0');
    return Promise.resolve({
      emails: [summary(counter.calls)],
      hasMore: true,
      nextCursor: null,
    });
  });
  return counter;
}

beforeEach(() => {
  resetApiMocks();
  mockGetEmail.mockImplementation((id: number) => Promise.resolve(detail(id)));
});

describe('runSync when the server stops handing out cursors', () => {
  it('stops instead of refetching page 0 when hasMore has no cursor', async () => {
    const server = cursorlessServer();

    const result = await sync();

    expect(server.calls).toBe(1);
    expect(result.stop).toBe('cursor-missing');
    expect(result.synced).toBe(1);
  });

  it('warns the user, and points them at the sync that can recover', async () => {
    cursorlessServer();
    const messages: string[] = [];

    await sync((msg) => messages.push(msg));

    const warning = messages.find((m) => m.includes('some emails may be missing'));
    expect(warning).toBeDefined();
    expect(warning).toContain('Fetch all notes');
  });

  it('does not follow the warning with a summary claiming a clean run', async () => {
    cursorlessServer();
    const messages: string[] = [];

    await sync((msg) => messages.push(msg));

    expect(messages.some((m) => m.includes('Sync summary'))).toBe(false);
  });

  it('keeps emails it never reached in the fetch log on a cut-short fetch-all', async () => {
    const { plugin, run } = harness('fetch-all');
    await plugin.saveData({
      'fetch-log': { '1': { fetchedAt: '2021-01-01T00:00:00.000Z' } },
    });
    mockListEmails.mockResolvedValue({
      emails: [summary(2)],
      hasMore: true,
      nextCursor: null,
    });

    const result = await run();

    expect(result.stop).toBe('cursor-missing');
    const log = await loadFetchLog(plugin as unknown as ObsidianPlugin);
    expect(Object.keys(log).sort()).toEqual(['1', '2']);
  });

  it('rewrites the fetch log when fetch-all does reach the end', async () => {
    const { plugin, run } = harness('fetch-all');
    await plugin.saveData({
      'fetch-log': { '1': { fetchedAt: '2021-01-01T00:00:00.000Z' } },
    });
    mockListEmails.mockResolvedValue({
      emails: [summary(2)],
      hasMore: false,
      nextCursor: null,
    });

    const result = await run();

    expect(result.stop).toBe('complete');
    const log = await loadFetchLog(plugin as unknown as ObsidianPlugin);
    expect(Object.keys(log)).toEqual(['2']);
  });
});

describe('runSync when the server repeats a cursor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2021-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up once the walk outlives its time budget', async () => {
    // The cursor is present, so the cursor-missing guard never fires. Each
    // page costs a minute of the mocked clock, so only the budget can end it.
    let calls = 0;
    mockListEmails.mockImplementation(() => {
      calls += 1;
      if (calls > 50) throw new Error('paginateEmails ignored its time budget');
      vi.advanceTimersByTime(60_000);
      return Promise.resolve({
        emails: [summary(calls)],
        hasMore: true,
        nextCursor: 'same-cursor-every-time',
      });
    });

    const result = await sync();

    expect(result.stop).toBe('timed-out');
    expect(calls).toBeLessThan(10);
  });
});

describe('runSync on a well-behaved server', () => {
  it('walks every page', async () => {
    mockListEmails
      .mockResolvedValueOnce({ emails: [summary(1)], hasMore: true, nextCursor: 'c1' })
      .mockResolvedValueOnce({ emails: [summary(2)], hasMore: false, nextCursor: null });

    const result = await sync();

    expect(mockListEmails).toHaveBeenCalledTimes(2);
    expect(mockListEmails.mock.calls[1][0]).toMatchObject({ cursor: 'c1' });
    expect(result.stop).toBe('complete');
    expect(result.synced).toBe(2);
  });

  it('does not flag a clean single-page sync as truncated', async () => {
    mockListEmails.mockResolvedValue({
      emails: [summary(1)],
      hasMore: false,
      nextCursor: null,
    });

    const result = await sync();

    expect(mockListEmails).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe('complete');
  });
});
