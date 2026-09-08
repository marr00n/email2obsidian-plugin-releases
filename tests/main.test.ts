import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import Email2ObsidianPlugin, {
  normalizeSettings,
  normalizeSyncInterval,
  syncIntervalToMs,
} from '../src/main';
import { App, Plugin, Vault } from './obsidian-fakes';
import { mockListEmails, mockGetEmail, resetApiMocks } from './api-mock';

vi.mock('../src/api', async () => (await import('./api-mock')).apiMock());

/**
 * A plugin driven the way Obsidian drives it: constructed, loaded, then poked
 * through the commands it registered. Nothing here reaches past `onload` into
 * the plugin's internals, so a rename inside it doesn't break these tests.
 */
async function loadedPlugin() {
  const vault = new Vault();
  const plugin = new Email2ObsidianPlugin(
    new App(vault) as never,
    { id: 'email2obsidian', version: '0.0.0' } as never
  );
  await plugin.onload();
  return { plugin, vault };
}

function runCommand(plugin: Email2ObsidianPlugin, id: string): void {
  const { commands } = plugin as unknown as Plugin;
  const command = commands.find((c) => c.id === id);
  if (!command) throw new Error(`No command registered with id ${id}`);
  command.callback();
}

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
    expect(normalizeSyncInterval('bad' as never)).toBe('daily');
    expect(syncIntervalToMs('1h')).toBe(60 * 60 * 1000);
  });
});

describe('the plugin as a user drives it', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).window = {
      setInterval: vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms)),
      clearInterval: vi.fn((id: number) => clearTimeout(id)),
    };
    resetApiMocks();
    mockListEmails.mockResolvedValue({ emails: [], hasMore: false, nextCursor: null });
    mockGetEmail.mockResolvedValue({
      id: 1,
      subject: 'Hi',
      createdAt: '2021',
      hashtags: null,
      markdownBody: 'Body',
      attachments: [],
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it('registers both sync commands on load', async () => {
    const { plugin } = await loadedPlugin();

    const ids = (plugin as unknown as Plugin).commands.map((c) => c.id);
    expect(ids).toContain('fetch-new');
    expect(ids).toContain('fetch-all');
  });

  it('writes a note and records the run when the fetch-new command fires', async () => {
    mockListEmails.mockResolvedValue({
      emails: [{ id: 1, subject: 'Hi', createdAt: '2021', hashtags: null }],
      hasMore: false,
      nextCursor: null,
    });
    const { plugin, vault } = await loadedPlugin();
    await plugin.updateSettings({ apiKey: 'k', notesFolder: 'Notes' });

    runCommand(plugin, 'fetch-new');

    await vi.waitFor(() => expect(plugin.settings.lastRunAt).not.toBeNull());
    expect(vault.getAbstractFileByPath('Notes/Hi.md')).toBeTruthy();
  });

  it('refuses a second sync while one is still running', async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockListEmails.mockImplementation(async () => {
      await inFlight;
      return { emails: [], hasMore: false, nextCursor: null };
    });
    const { plugin } = await loadedPlugin();
    await plugin.updateSettings({ apiKey: 'k', notesFolder: 'Notes' });

    runCommand(plugin, 'fetch-new');
    runCommand(plugin, 'fetch-new');

    await vi.waitFor(() => expect(mockListEmails).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(plugin.settings.lastRunAt).not.toBeNull());
    expect(mockListEmails).toHaveBeenCalledTimes(1);
  });

  it('starts a timer when periodic sync is switched on, and clears it when switched off', async () => {
    const { plugin } = await loadedPlugin();

    await plugin.updateSettings({ apiKey: 'k', periodicSync: true, syncInterval: '1h' });
    expect(window.setInterval).toHaveBeenCalled();
    expect(vi.mocked(window.setInterval).mock.calls[0][1]).toBe(60 * 60 * 1000);

    await plugin.updateSettings({ periodicSync: false });
    expect(window.clearInterval).toHaveBeenCalled();
  });
});
