import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import Email2ObsidianPlugin, {
  normalizeSettings,
  normalizeFolder,
  normalizeSyncInterval,
  syncIntervalToMs,
} from '../src/main';
import { App, Plugin, Vault } from 'obsidian';

const mockRunSync = vi.fn();

vi.mock('../src/pipeline', () => ({
  runSync: (...args: any[]) => mockRunSync(...args),
}));

const makePlugin = () => new Email2ObsidianPlugin(new App(new Vault()), {} as any);

describe('main normalization helpers', () => {
  it('normalizes settings and folders', () => {
    const normalized = normalizeSettings({
      apiKey: ' key ',
      notesFolder: '.',
      periodicSync: 'yes',
      runOnOpen: 1,
      lastRunAt: '2023-01-01',
    });

    expect(normalized.apiKey).toBe('key');
    expect(normalized.notesFolder).toBe('.');
    expect(normalized.periodicSync).toBe(true);
    expect(normalized.runOnOpen).toBe(true);
    expect(normalized.lastRunAt).toBe('2023-01-01');
  });

  it('handles sync interval defaults and conversion', () => {
    expect(normalizeSyncInterval('3h')).toBe('3h');
    expect(normalizeSyncInterval('bad' as any)).toBe('daily');
    expect(syncIntervalToMs('1h')).toBe(60 * 60 * 1000);
  });
});

describe('plugin scheduler and sync guard', () => {
  beforeEach(() => {
    (global as any).window = {
      setInterval: vi.fn((fn: any, ms: number) => {
        return setTimeout(fn, ms);
      }),
      clearInterval: vi.fn((id: any) => clearTimeout(id)),
    } as any;
    mockRunSync.mockReset();
    mockRunSync.mockResolvedValue({ errors: [], attachmentErrors: [] });
  });

  afterEach(() => {
    delete (global as any).window;
  });

  it('guards concurrent syncs in handleSync and updates lastRunAt on success', async () => {
    const plugin = makePlugin();
    mockRunSync.mockResolvedValueOnce({ errors: [], attachmentErrors: [] });

    await plugin['handleSync']('fetch-new');
    expect(mockRunSync).toHaveBeenCalledTimes(1);
    const lastRun = plugin.settings.lastRunAt;
    expect(typeof lastRun).toBe('string');

    // second call while syncing should no-op
    plugin['isSyncing'] = true;
    await plugin['handleSync']('fetch-new');
    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it('schedules periodic sync and clears previous interval', async () => {
    const plugin = makePlugin();
    plugin.settings.periodicSync = true;
    plugin.settings.syncInterval = '1h';
    const runSpy = vi.spyOn(plugin as any, 'handleSync');

    plugin['setupScheduler'](true);
    expect((window.setInterval as any)).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalled();

    plugin['setupScheduler']();
    expect((window.clearInterval as any)).toHaveBeenCalled();
  });
});
