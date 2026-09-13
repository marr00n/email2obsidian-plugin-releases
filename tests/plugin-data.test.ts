import { describe, it, expect, vi } from 'vitest';

import { pluginDataStore, type PluginDataHost } from '../src/plugin-data';

/**
 * A data host that yields between reading and writing, the way a real
 * `data.json` on disk does. Without the gap two overlapping read-modify-writes
 * happen to run to completion one at a time and the collision never shows.
 */
function slowHost(initial: Record<string, unknown> = {}): PluginDataHost & {
  saved: () => Record<string, unknown>;
} {
  let data: Record<string, unknown> = initial;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    async loadData() {
      await tick();
      return data;
    },
    async saveData(value: unknown) {
      await tick();
      data = value as Record<string, unknown>;
    },
    saved: () => data,
  };
}

describe('plugin data store', () => {
  it('hands the same store back for the same plugin', () => {
    const host = slowHost();

    expect(pluginDataStore(host)).toBe(pluginDataStore(host));
    expect(pluginDataStore(slowHost())).not.toBe(pluginDataStore(host));
  });

  it('keeps two overlapping owners from overwriting each other', async () => {
    const host = slowHost();
    const store = pluginDataStore(host);

    // Started together, the way a settings save lands on a running fetch.
    await Promise.all([
      store.update((envelope) => ({ ...envelope, settings: { apiKey: 'k' } })),
      store.update((envelope) => ({ ...envelope, 'fetch-log': { '1': {} } })),
    ]);

    expect(host.saved()).toEqual({
      settings: { apiKey: 'k' },
      'fetch-log': { '1': {} },
    });
  });

  it('hands the mutator the envelope as it is when its turn comes', async () => {
    const host = slowHost();
    const store = pluginDataStore(host);
    const seen: Record<string, unknown>[] = [];

    await Promise.all([
      store.update((envelope) => ({ ...envelope, first: true })),
      store.update((envelope) => {
        seen.push({ ...envelope });
        return { ...envelope, second: true };
      }),
    ]);

    // Not the envelope read before the first write — the one it left behind.
    expect(seen).toEqual([{ first: true }]);
  });

  it('reads back an empty envelope when there is nothing usable stored', async () => {
    const nothing: PluginDataHost = {
      loadData: () => Promise.resolve(null),
      saveData: () => Promise.resolve(),
    };

    expect(await pluginDataStore(nothing).read()).toEqual({});
  });

  it('surfaces a failed write to its caller without wedging the queue', async () => {
    const host = slowHost();
    const saveData = vi
      .fn(host.saveData)
      .mockRejectedValueOnce(new Error('disk full'));
    const store = pluginDataStore({ loadData: host.loadData, saveData });

    await expect(
      store.update((envelope) => ({ ...envelope, doomed: true }))
    ).rejects.toThrow('disk full');

    await store.update((envelope) => ({ ...envelope, settings: { apiKey: 'k' } }));
    expect(host.saved()).toEqual({ settings: { apiKey: 'k' } });
  });
});
