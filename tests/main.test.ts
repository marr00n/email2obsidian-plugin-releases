import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import Email2ObsidianPlugin, {
  DebouncedSave,
  TEXT_SAVE_DELAY_MS,
  normalizeSettings,
  normalizeFolder,
  normalizeSyncInterval,
  syncIntervalToMs,
} from '../src/main';
import { openLedger } from '../src/fetch-ledger';
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

  it('keeps the unmarked answer stored even while blank markers make it inapplicable', () => {
    // The settings tab disables the toggle when markers are blank, and the
    // policy stops reading it — but the answer itself survives, so filling
    // the markers field back in restores the user's own choice.
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

/**
 * Give the plugin a data file that yields between reading and writing, the
 * way a real `data.json` on disk does. Without the gap, two read-modify-writes
 * started together happen to run one at a time and the collision never shows.
 */
function installSlowData(plugin: Plugin): void {
  let data: Record<string, unknown> = {};
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  plugin.loadData = async () => {
    await tick();
    return data;
  };
  plugin.saveData = async (value: unknown) => {
    await tick();
    data = value as Record<string, unknown>;
  };
}

describe('settings and the fetch ledger share data.json', () => {
  it('a settings save landing mid-fetch cannot carry away the ledger', async () => {
    const plugin = makePlugin();
    installSlowData(plugin);
    await plugin.loadSettings();

    const ledger = await openLedger(plugin, {
      clock: () => '2021-01-01T00:00:00.000Z',
    });
    ledger.accept(1, 'One.md');

    // The user changes a setting while the fetch is committing. Read-modify-
    // write is not atomic, so before both went through one queue whichever
    // saved second wrote an envelope that predated the other's change — and
    // losing the ledger means those emails import again as `-1` duplicates.
    plugin.settings.notesFolder = 'Inbox';
    await Promise.all([
      ledger.commit({ mode: 'fetch-new', cutShort: false }),
      plugin.saveSettings(),
    ]);

    const envelope = (await plugin.loadData()) as {
      settings: { notesFolder: string };
      'fetch-log': Record<string, unknown>;
    };
    expect(envelope['fetch-log']).toHaveProperty('1');
    expect(envelope.settings.notesFolder).toBe('Inbox');
  });

  it('holds the ledger too when the settings save goes first', async () => {
    const plugin = makePlugin();
    installSlowData(plugin);
    await plugin.loadSettings();

    const ledger = await openLedger(plugin, {
      clock: () => '2021-01-01T00:00:00.000Z',
    });
    ledger.accept(2, 'Two.md');

    plugin.settings.apiKey = 'key';
    await Promise.all([
      plugin.saveSettings(),
      ledger.commit({ mode: 'fetch-new', cutShort: false }),
    ]);

    const envelope = (await plugin.loadData()) as {
      settings: { apiKey: string };
      'fetch-log': Record<string, unknown>;
    };
    expect(envelope['fetch-log']).toHaveProperty('2');
    expect(envelope.settings.apiKey).toBe('key');
  });
});

describe('debounced text field saves', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (global as any).window = {
      setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: any) => globalThis.clearTimeout(id),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (global as any).window;
  });

  it('saves once when the typing stops, not once per keystroke', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const saver = new DebouncedSave(TEXT_SAVE_DELAY_MS, save);

    // Three keystrokes: before this, three full writes of data.json and three
    // restarts of the background fetch timer.
    for (const value of ['a', 'ab', 'abc']) saver.schedule(value);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TEXT_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
  });

  it('flush saves what is waiting at once, and the timer then has nothing left', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const saver = new DebouncedSave(TEXT_SAVE_DELAY_MS, save);

    saver.schedule('abc');
    await saver.flush();
    expect(save).toHaveBeenCalledWith('abc');

    await vi.advanceTimersByTimeAsync(TEXT_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush with nothing waiting saves nothing', async () => {
    const save = vi.fn().mockResolvedValue(undefined);

    await new DebouncedSave(TEXT_SAVE_DELAY_MS, save).flush();

    expect(save).not.toHaveBeenCalled();
  });
});
