/* -------------------------------------------------------------------------
 * Plugin data store
 *
 * `data.json` is one file with two owners: `settings`, written by the
 * settings panel, and `fetch-log`, written by the Fetch Ledger. Both change
 * it the same way — load the envelope, replace their own key, save the whole
 * envelope back — and that read-modify-write is not atomic. Two of them
 * overlapping means whichever saves second writes an envelope it read before
 * the other's change existed, and that change is gone.
 *
 * Losing the settings half is survivable: the plugin still holds them in
 * memory and saves them again. Losing the ledger half is permanent. The
 * plugin forgets which emails it has already imported, and the next fetch
 * writes those notes a second time as `-1` duplicates.
 *
 * So every read and write of `data.json` goes through one queue per plugin
 * instance. `update` holds that queue across the load, the change and the
 * save, which is exactly what makes the read-modify-write atomic with
 * respect to the other owner.
 * ---------------------------------------------------------------------- */

/**
 * The part of Obsidian's `Plugin` this needs. Structural, so the real plugin
 * and a test fake both fit without either knowing about this module.
 */
export interface PluginDataHost {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface PluginDataStore {
  /** The stored envelope — `{}` when there is nothing, or nothing usable. */
  read(): Promise<Record<string, unknown>>;
  /**
   * Load, change and save the envelope with no other writer in between.
   *
   * The mutator is handed the envelope as it is on disk at that moment, not
   * one read earlier, and returns what replaces it. It must be synchronous:
   * awaiting inside it would hold the queue open on work that is not a write,
   * and calling back into the store from it would deadlock.
   */
  update(
    mutate: (envelope: Record<string, unknown>) => Record<string, unknown>
  ): Promise<void>;
}

/**
 * One store per plugin instance, so the settings panel and the ledger share a
 * queue without having to be handed one. Keyed weakly: a plugin that unloads
 * takes its queue with it.
 */
const stores = new WeakMap<PluginDataHost, PluginDataStore>();

export function pluginDataStore(host: PluginDataHost): PluginDataStore {
  const existing = stores.get(host);
  if (existing) return existing;
  const created = createStore(host);
  stores.set(host, created);
  return created;
}

function createStore(host: PluginDataHost): PluginDataStore {
  // The tail of the queue. Every operation chains onto it, so operations run
  // one after another however they were started. The tail swallows failures
  // — the caller still sees its own rejection — so one failed write does not
  // wedge every write after it.
  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  }

  async function loadEnvelope(): Promise<Record<string, unknown>> {
    const raw: unknown = await host.loadData();
    return isRecord(raw) ? raw : {};
  }

  return {
    read: () => enqueue(loadEnvelope),
    update: (mutate) =>
      enqueue(async () => {
        const envelope = await loadEnvelope();
        await host.saveData(mutate(envelope));
      }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
