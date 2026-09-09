import { describe, it, expect } from 'vitest';

import { openLedger, type LedgerData } from '../src/fetch-ledger';
import type { EmailSummary } from '../src/api';
import { App, Plugin, Vault } from 'obsidian';

function newPlugin(): Plugin {
  return new Plugin(new App(new Vault()));
}

/** A log in the shape every pre-decline version of the plugin wrote. */
function oldFormatLog(): Record<string, unknown> {
  return {
    '7': { fetchedAt: '2021-01-07T00:00:00.000Z', filename: 'Seven.md' },
    '6': { fetchedAt: '2021-01-06T00:00:00.000Z' },
  };
}

async function storedLog(plugin: Plugin): Promise<LedgerData> {
  const envelope = (await plugin.loadData()) as { 'fetch-log'?: LedgerData };
  return envelope['fetch-log'] ?? {};
}

function summary(id: number): EmailSummary {
  return {
    id,
    subject: `Subject ${id}`,
    createdAt: '2021-01-01 00:00:00',
    hashtags: [],
    vault: null,
  };
}

const clock = () => '2021-02-02T00:00:00.000Z';

describe('fetch ledger', () => {
  it('loads a log written by the old format, with every entry accepted', async () => {
    const plugin = newPlugin();
    await plugin.saveData({ 'fetch-log': oldFormatLog() });

    const ledger = await openLedger(plugin, { clock });

    expect(ledger.hasSeen(7)).toBe(true);
    expect(ledger.hasSeen(6)).toBe(true);
    expect(ledger.hasSeen(5)).toBe(false);

    // Nothing declined, so a policy change has nothing to drop and the log
    // survives a commit unchanged.
    ledger.forgetDeclines();
    await ledger.commit({ mode: 'fetch-new', cutShort: false });
    expect(await storedLog(plugin)).toEqual({
      '7': { fetchedAt: '2021-01-07T00:00:00.000Z', filename: 'Seven.md' },
      '6': { fetchedAt: '2021-01-06T00:00:00.000Z', filename: undefined },
    });
  });

  it('shares the saveData envelope with settings in both directions', async () => {
    const plugin = newPlugin();

    // Settings first, ledger second: the ledger keeps the settings key.
    await plugin.saveData({ settings: { apiKey: 'k', notesFolder: 'Notes' } });
    const ledger = await openLedger(plugin, { clock });
    ledger.accept(1, 'One.md');
    await ledger.commit({ mode: 'fetch-new', cutShort: false });

    let envelope = (await plugin.loadData()) as Record<string, unknown>;
    expect(envelope.settings).toEqual({ apiKey: 'k', notesFolder: 'Notes' });
    expect(envelope['fetch-log']).toHaveProperty('1');

    // Ledger first, settings second: a settings writer keeps the fetch log.
    const raw = (await plugin.loadData()) as Record<string, unknown>;
    await plugin.saveData({ ...raw, settings: { apiKey: 'k2', notesFolder: 'Inbox' } });

    envelope = (await plugin.loadData()) as Record<string, unknown>;
    expect(envelope.settings).toEqual({ apiKey: 'k2', notesFolder: 'Inbox' });
    expect(envelope['fetch-log']).toHaveProperty('1');
  });

  it('reports an id as seen once it is accepted, before any commit', async () => {
    const plugin = newPlugin();
    const ledger = await openLedger(plugin, { clock });

    expect(ledger.hasSeen(1)).toBe(false);
    ledger.accept(1, 'One.md');
    expect(ledger.hasSeen(1)).toBe(true);
  });

  it('stops the scan on a page holding a seen id, and only on such a page', async () => {
    const plugin = newPlugin();
    await plugin.saveData({ 'fetch-log': oldFormatLog() });
    const ledger = await openLedger(plugin, { clock });

    expect(ledger.shouldStopScan([summary(9), summary(8)])).toBe(false);
    expect(ledger.shouldStopScan([])).toBe(false);
    expect(ledger.shouldStopScan([summary(8), summary(7)])).toBe(true);
    expect(ledger.shouldStopScan([summary(6)])).toBe(true);
  });

  it('appends on a fetch-new commit without duplicating an already-logged id', async () => {
    const plugin = newPlugin();
    await plugin.saveData({ 'fetch-log': oldFormatLog() });
    const ledger = await openLedger(plugin, { clock });

    ledger.accept(8, 'Eight.md');
    ledger.accept(7, 'Seven renamed.md');
    await ledger.commit({ mode: 'fetch-new', cutShort: false });

    const log = await storedLog(plugin);
    expect(Object.keys(log).sort()).toEqual(['6', '7', '8']);
    expect(log['8']).toEqual({ fetchedAt: clock(), filename: 'Eight.md' });
    expect(log['7']).toEqual({ fetchedAt: clock(), filename: 'Seven renamed.md' });
  });

  it('rewrites the whole log on a fetch-all commit', async () => {
    const plugin = newPlugin();
    await plugin.saveData({ 'fetch-log': oldFormatLog() });
    const ledger = await openLedger(plugin, { clock });

    ledger.accept(9, 'Nine.md');
    await ledger.commit({ mode: 'fetch-all', cutShort: false });

    expect(await storedLog(plugin)).toEqual({
      '9': { fetchedAt: clock(), filename: 'Nine.md' },
    });
  });

  it('keeps the accepted prefix when a fetch-new run is cut short', async () => {
    const plugin = newPlugin();
    await plugin.saveData({ 'fetch-log': oldFormatLog() });
    const ledger = await openLedger(plugin, { clock });

    ledger.accept(9, 'Nine.md');
    await ledger.commit({ mode: 'fetch-new', cutShort: true });

    const log = await storedLog(plugin);
    expect(Object.keys(log).sort()).toEqual(['6', '7', '9']);
  });

  it('writes nothing when a fetch-all run is cut short', async () => {
    const plugin = newPlugin();
    await plugin.saveData({ 'fetch-log': oldFormatLog() });
    const ledger = await openLedger(plugin, { clock });

    ledger.accept(9, 'Nine.md');
    await ledger.commit({ mode: 'fetch-all', cutShort: true });

    // A rewrite from a partial run would have thrown away 6 and 7.
    expect(await storedLog(plugin)).toEqual(oldFormatLog());
  });

  it('writes nothing on a fetch-new commit that decided nothing', async () => {
    const plugin = newPlugin();
    await plugin.saveData({ 'fetch-log': oldFormatLog(), settings: { apiKey: 'k' } });
    const ledger = await openLedger(plugin, { clock });

    await ledger.commit({ mode: 'fetch-new', cutShort: false });

    expect(await plugin.loadData()).toEqual({
      'fetch-log': oldFormatLog(),
      settings: { apiKey: 'k' },
    });
  });

  it('records a decline as seen, marked, and readable by the old format', async () => {
    const plugin = newPlugin();
    const ledger = await openLedger(plugin, { clock });

    ledger.decline(5);
    expect(ledger.hasSeen(5)).toBe(true);
    await ledger.commit({ mode: 'fetch-new', cutShort: false });

    expect(await storedLog(plugin)).toEqual({
      '5': { fetchedAt: clock(), status: 'declined' },
    });

    // Reloading sees it as declined and still as dealt with.
    const reopened = await openLedger(plugin, { clock });
    expect(reopened.hasSeen(5)).toBe(true);
    expect(reopened.shouldStopScan([summary(5)])).toBe(true);
  });

  it('forgets declines only, leaving accepted entries in place', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '7': { fetchedAt: '2021-01-07T00:00:00.000Z', filename: 'Seven.md' },
        '6': { fetchedAt: '2021-01-06T00:00:00.000Z', status: 'declined' },
      },
    });
    const ledger = await openLedger(plugin, { clock });

    ledger.decline(5);
    expect(ledger.hasSeen(6)).toBe(true);

    ledger.forgetDeclines();
    expect(ledger.hasSeen(6)).toBe(false);
    expect(ledger.hasSeen(5)).toBe(false);
    expect(ledger.hasSeen(7)).toBe(true);

    // Dropping declines is worth a write even though nothing was accepted.
    await ledger.commit({ mode: 'fetch-new', cutShort: false });
    expect(await storedLog(plugin)).toEqual({
      '7': { fetchedAt: '2021-01-07T00:00:00.000Z', filename: 'Seven.md' },
    });
  });

  it('routes a load failure through a supplied warn instead of console.warn', async () => {
    const plugin = newPlugin();
    plugin.loadData = () => Promise.reject(new Error('disk exploded'));
    const warnings: unknown[][] = [];

    const ledger = await openLedger(plugin, {
      clock,
      warn: (msg, ...details) => warnings.push([msg, ...details]),
    });

    expect(ledger.hasSeen(1)).toBe(false);
    expect(warnings).toEqual([['Failed to load fetch ledger via plugin data: disk exploded']]);
  });
});
