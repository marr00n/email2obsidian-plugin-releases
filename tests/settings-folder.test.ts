import { describe, it, expect, vi } from 'vitest';

/**
 * Obsidian's `normalizePath` refuses some names outright. The fake used
 * everywhere else never throws, so the one path that matters here — what the
 * plugin does when a typed folder cannot be made into a path — needs a
 * `normalizePath` that does.
 */
const REFUSED = 'refuse-me';
vi.mock('obsidian', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    normalizePath: (input: string) => {
      if (input.includes(REFUSED)) throw new Error('bad path');
      return (actual.normalizePath as (p: string) => string)(input);
    },
  };
});

const { App, Plugin, Vault } = await import('obsidian');
const { default: Email2ObsidianPlugin } = await import('../src/main');

vi.mock('../src/pipeline', () => ({ runSync: vi.fn() }));

describe('a notes folder Obsidian refuses', () => {
  function makePlugin() {
    (globalThis as unknown as { window: unknown }).window = {
      setInterval: () => 1,
      clearInterval: () => undefined,
    };
    return new Email2ObsidianPlugin(new App(new Vault()), {} as never);
  }

  it('leaves the folder in use alone and tells the user why', async () => {
    const plugin = makePlugin();
    await plugin.updateSettings({ notesFolder: 'Inbox' });

    // Injected after the first save, because `updateSettings` rebuilds the
    // report at the end of every call. The report is the plugin's one seam
    // for user-facing messages.
    const notices: string[] = [];
    (plugin as unknown as { report: unknown }).report = {
      notice: (msg: string) => notices.push(msg),
      warn: () => undefined,
      debug: () => undefined,
    };

    await plugin.updateSettings({ notesFolder: REFUSED });

    expect(plugin.settings.notesFolder).toBe('Inbox');
    expect(notices.at(-1)).toContain('Inbox');
    expect(notices.at(-1)).toContain(REFUSED);
  });
});
