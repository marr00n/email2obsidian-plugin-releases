import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import Email2ObsidianPlugin, {
  normalizeSettings,
  normalizeFolder,
  normalizeSyncInterval,
  syncIntervalToMs,
} from '../src/main';
import { App, Plugin, Vault } from 'obsidian';
import { describeDeclines, formatVaultMarkers } from '../src/receive-policy';

const mockRunSync = vi.fn();

vi.mock('../src/pipeline', () => ({
  runSync: (...args: any[]) => mockRunSync(...args),
}));

const makePlugin = () => new Email2ObsidianPlugin(new App(new Vault()), {} as any);

/** A run that did nothing, for tests that only care about one field of it. */
const syncResult = (overrides: Record<string, unknown> = {}) => ({
  synced: 0,
  skipped: 0,
  declined: 0,
  declinedByMarker: [],
  starterSignature: false,
  errors: [],
  attachmentErrors: [],
  ...overrides,
});

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

  it('defaults an install that has never seen this feature to receiving everything', () => {
    const normalized = normalizeSettings({ apiKey: 'k' });

    // Blank markers is the absence of a filter, not an empty allow list, so
    // this pair is byte-identical to the plugin's pre-multi-vault behaviour.
    expect(normalized.vaultMarkers).toEqual([]);
    expect(normalized.receiveUnmarked).toBe(true);
    expect(normalized.lastDeclined).toEqual([]);
    expect(normalized.starterSignatureSeen).toBe(false);
  });

  it('parses the markers field on semicolons, trimming, dropping empties and collapsing duplicates', () => {
    const normalized = normalizeSettings({
      apiKey: 'k',
      vaultMarkers: '  Work ;; Second Brain ; work ;  ',
    });

    // `work` is the same Obsidian Vault as `Work`, and the spelling the user
    // typed first is the one they see again.
    expect(normalized.vaultMarkers).toEqual(['Work', 'Second Brain']);
    expect(formatVaultMarkers(normalized.vaultMarkers)).toBe('Work; Second Brain');
  });

  it('reads back the markers list a previous save persisted', () => {
    expect(
      normalizeSettings({ apiKey: 'k', vaultMarkers: ['Work', 'Art'] }).vaultMarkers
    ).toEqual(['Work', 'Art']);
    // Anything that is neither a string nor a list of them is no filter.
    expect(normalizeSettings({ apiKey: 'k', vaultMarkers: 42 }).vaultMarkers).toEqual([]);
  });

  it('keeps the unmarked answer live whatever the marker list says', () => {
    expect(
      normalizeSettings({ apiKey: 'k', vaultMarkers: [], receiveUnmarked: false })
        .receiveUnmarked
    ).toBe(false);
    expect(
      normalizeSettings({ apiKey: 'k', receiveUnmarked: 'no' }).receiveUnmarked
    ).toBe(true);
  });

  it('keeps only a well-formed last-fetch decline tally', () => {
    const normalized = normalizeSettings({
      apiKey: 'k',
      lastDeclined: [
        { marker: 'Art', count: 4 },
        { marker: '', count: 2 },
        { marker: 'Wrok', count: 'lots' },
        'rubbish',
      ],
    });

    expect(normalized.lastDeclined).toEqual([
      { marker: 'Art', count: 4 },
      { marker: '', count: 2 },
    ]);
    expect(describeDeclines(normalized.lastDeclined)).toBe('Art (4), no marker (2)');
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
    mockRunSync.mockResolvedValue(syncResult());
  });

  afterEach(() => {
    delete (global as any).window;
  });

  it('guards concurrent syncs in handleSync and updates lastRunAt on success', async () => {
    const plugin = makePlugin();
    mockRunSync.mockResolvedValueOnce(syncResult());

    await plugin['handleSync']('fetch-new');
    expect(mockRunSync).toHaveBeenCalledTimes(1);
    const lastRun = plugin.settings.lastRunAt;
    expect(typeof lastRun).toBe('string');

    // second call while syncing should no-op
    plugin['isSyncing'] = true;
    await plugin['handleSync']('fetch-new');
    expect(mockRunSync).toHaveBeenCalledTimes(1);
  });

  it('records what the last fetch declined, and what a quiet poll after it did not', async () => {
    const plugin = makePlugin();

    mockRunSync.mockResolvedValueOnce(
      syncResult({
        synced: 1,
        declined: 4,
        declinedByMarker: [{ marker: 'Art', count: 4 }],
        starterSignature: true,
      })
    );
    await plugin.handleSync('fetch-new');
    expect(plugin.settings.lastDeclined).toEqual([{ marker: 'Art', count: 4 }]);
    expect(plugin.settings.starterSignatureSeen).toBe(true);

    // A background poll that found nothing new has learned nothing, so it must
    // not wipe the readout the user has not looked at yet.
    mockRunSync.mockResolvedValueOnce(syncResult());
    await plugin.handleSync('fetch-new');
    expect(plugin.settings.lastDeclined).toEqual([{ marker: 'Art', count: 4 }]);
    expect(plugin.settings.starterSignatureSeen).toBe(true);

    // A run that did look at new email replaces it.
    mockRunSync.mockResolvedValueOnce(syncResult({ synced: 2 }));
    await plugin.handleSync('fetch-new');
    expect(plugin.settings.lastDeclined).toEqual([]);
    expect(plugin.settings.starterSignatureSeen).toBe(false);
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
