import { describe, it, expect } from 'vitest';

import { openLedger, type LedgerData } from '../src/fetch-ledger';
import { createReceivePolicy } from '../src/receive-policy';
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

function summary(id: number, vaultMarker: string | null = null): EmailSummary {
  return {
    id,
    subject: `Subject ${id}`,
    createdAt: '2021-01-01 00:00:00',
    hashtags: [],
    vaultMarker,
  };
}

const clock = () => '2021-02-02T00:00:00.000Z';
/** Inside the service's 72-hour window, measured from `clock`. */
const RECENT = '2021-02-01T00:00:00.000Z';
/** Older than the window: the service has deleted this email. */
const EXPIRED = '2021-01-20T00:00:00.000Z';

const claimsWork = createReceivePolicy({ markers: ['Work'], unmarked: false });

describe('fetch ledger', () => {
  it('loads a log written by the old format, with every entry accepted', async () => {
    const plugin = newPlugin();
    await plugin.saveData({ 'fetch-log': oldFormatLog() });

    const ledger = await openLedger(plugin, { clock });

    expect(ledger.hasSeen(7)).toBe(true);
    expect(ledger.hasSeen(6)).toBe(true);
    expect(ledger.hasSeen(5)).toBe(false);

    // Nothing declined, so a policy change has nothing to release and the
    // log survives a commit unchanged.
    expect(ledger.release(claimsWork)).toBe(0);
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

  it('records a decline as seen, with the Vault Marker it arrived under', async () => {
    const plugin = newPlugin();
    const ledger = await openLedger(plugin, { clock });

    ledger.decline(5, 'Art');
    ledger.decline(4, null);
    expect(ledger.hasSeen(5)).toBe(true);
    await ledger.commit({ mode: 'fetch-new', cutShort: false });

    expect(await storedLog(plugin)).toEqual({
      '5': { fetchedAt: clock(), status: 'declined', vaultMarker: 'Art' },
      // An Unmarked Email declines under the empty marker, not a missing one:
      // a later release has to tell "was unmarked" from "was not recorded".
      '4': { fetchedAt: clock(), status: 'declined', vaultMarker: '' },
    });

    // Reloading sees it as declined and still as dealt with.
    const reopened = await openLedger(plugin, { clock });
    expect(reopened.hasSeen(5)).toBe(true);
    expect(reopened.shouldStopScan([summary(5)])).toBe(true);
  });

  it('releases only the declines the new policy claims, leaving the rest alone', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '9': { fetchedAt: RECENT, filename: 'Nine.md' },
        '8': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' },
        '7': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Art' },
        '6': { fetchedAt: RECENT, status: 'declined', vaultMarker: '' },
      },
    });
    const ledger = await openLedger(plugin, { clock });

    // The markers setting has just grown a `Work` entry.
    expect(ledger.release(claimsWork)).toBe(1);

    // 8 is back in play; the accepted note and the still-unclaimed declines
    // are untouched.
    expect(ledger.hasSeen(8)).toBe(false);
    expect(ledger.hasSeen(9)).toBe(true);
    expect(ledger.hasSeen(7)).toBe(true);
    expect(ledger.hasSeen(6)).toBe(true);
  });

  it('matches a released marker case-insensitively and releases an unmarked decline on its own toggle', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '8': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'WORK' },
        '6': { fetchedAt: RECENT, status: 'declined', vaultMarker: '' },
      },
    });
    const ledger = await openLedger(plugin, { clock });

    expect(
      ledger.release(createReceivePolicy({ markers: ['  work  '], unmarked: true }))
    ).toBe(2);
    expect(ledger.hasSeen(8)).toBe(false);
    expect(ledger.hasSeen(6)).toBe(false);
  });

  it('leaves a decline the service has already deleted where it is', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '8': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' },
        // Declined outside the 72-hour retention window: widening the markers
        // cannot bring back an email the service no longer holds, and hunting
        // for it would only make every later scan read further.
        '3': { fetchedAt: EXPIRED, status: 'declined', vaultMarker: 'Work' },
      },
    });
    const ledger = await openLedger(plugin, { clock });

    expect(ledger.release(claimsWork)).toBe(1);
    expect(ledger.hasSeen(8)).toBe(false);
    expect(ledger.hasSeen(3)).toBe(true);
  });

  it('releases a decline recorded without a marker, since it cannot be ruled out', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': { '8': { fetchedAt: RECENT, status: 'declined' } },
    });
    const ledger = await openLedger(plugin, { clock });

    expect(ledger.release(claimsWork)).toBe(1);
    expect(ledger.hasSeen(8)).toBe(false);
  });

  it('keeps the scan running until every released id has been met again', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '9': { fetchedAt: RECENT, filename: 'Nine.md' },
        '8': { fetchedAt: RECENT, filename: 'Eight.md' },
        '7': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' },
        '6': { fetchedAt: RECENT, filename: 'Six.md' },
      },
    });
    const ledger = await openLedger(plugin, { clock });
    ledger.release(claimsWork);

    // Page one is nothing but known email, which would normally stop the scan
    // dead — but 7 is two pages back and this run exists to fetch it.
    expect(ledger.shouldStopScan([summary(9), summary(8)])).toBe(false);
    // Reaching 7 settles the debt, so this page stops the scan as usual.
    expect(ledger.shouldStopScan([summary(7, 'Work'), summary(6)])).toBe(true);
  });

  it('drops a released id the service never returned, so the next run stops scanning early again', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '9': { fetchedAt: RECENT, filename: 'Nine.md' },
        '7': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' },
      },
    });
    const ledger = await openLedger(plugin, { clock });
    ledger.release(claimsWork);

    // The run scanned the stream out and 7 was never in it: the service had
    // already deleted it. Holding on to it would make every future run read
    // the whole stream hunting for an email that no longer exists.
    await ledger.commit({ mode: 'fetch-new', cutShort: false });
    expect(await storedLog(plugin)).toEqual({
      '9': { fetchedAt: RECENT, filename: 'Nine.md' },
    });

    const reopened = await openLedger(plugin, { clock });
    expect(reopened.shouldStopScan([summary(9)])).toBe(true);
  });

  it('keeps a released id a cut-short run never reached, so the next run hunts it again', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '9': { fetchedAt: RECENT, filename: 'Nine.md' },
        '7': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' },
      },
    });
    const ledger = await openLedger(plugin, { clock });
    ledger.release(claimsWork);
    ledger.accept(9, 'Nine.md');

    // The rate limit hit before 7 was imported. The run stopped; the service
    // did not delete anything. Dropping 7 here would tear a hole in the
    // contiguous run, and the next scan would stop on 9 without ever
    // reaching 7 again — losing the very email the release existed to save.
    await ledger.commit({ mode: 'fetch-new', cutShort: true });
    expect(await storedLog(plugin)).toEqual({
      '9': { fetchedAt: clock(), filename: 'Nine.md' },
      '7': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' },
    });

    const reopened = await openLedger(plugin, { clock });
    expect(reopened.release(claimsWork)).toBe(1);
    expect(reopened.hasSeen(7)).toBe(false);
  });

  it('writes nothing when a cut-short run released ids but decided nothing', async () => {
    const plugin = newPlugin();
    const log = { '7': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' } };
    await plugin.saveData({ 'fetch-log': log, settings: { apiKey: 'k' } });
    const ledger = await openLedger(plugin, { clock });
    ledger.release(claimsWork);

    await ledger.commit({ mode: 'fetch-new', cutShort: true });
    expect(await plugin.loadData()).toEqual({
      'fetch-log': log,
      settings: { apiKey: 'k' },
    });
  });

  it('keeps a released id that the run went on to import', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '7': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' },
      },
    });
    const ledger = await openLedger(plugin, { clock });
    ledger.release(claimsWork);
    ledger.accept(7, 'Seven.md');

    await ledger.commit({ mode: 'fetch-new', cutShort: false });
    expect(await storedLog(plugin)).toEqual({
      '7': { fetchedAt: clock(), filename: 'Seven.md' },
    });
  });

  it('counts what a proposed marker list would release, per marker, without touching the log', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '9': { fetchedAt: RECENT, filename: 'Nine.md' },
        '8': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Art' },
        '7': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'art' },
        '6': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Work' },
        '5': { fetchedAt: RECENT, status: 'declined', vaultMarker: '' },
        '3': { fetchedAt: EXPIRED, status: 'declined', vaultMarker: 'Art' },
      },
    });
    const ledger = await openLedger(plugin, { clock });

    const pending = ledger.pendingRelease(
      createReceivePolicy({ markers: ['Art; Work'], unmarked: false })
    );

    // 3 is outside the retention window and 5 is unmarked with the toggle off.
    expect(pending.total).toBe(3);
    expect(pending.byMarker).toEqual([
      { marker: 'Art', count: 2 },
      { marker: 'Work', count: 1 },
    ]);

    // A question, not a decision: the declines are all still declined.
    expect(ledger.hasSeen(8)).toBe(true);
    expect(ledger.hasSeen(6)).toBe(true);
  });

  it('counts nothing pending when the proposed policy claims no declined email', async () => {
    const plugin = newPlugin();
    await plugin.saveData({
      'fetch-log': {
        '8': { fetchedAt: RECENT, status: 'declined', vaultMarker: 'Art' },
      },
    });
    const ledger = await openLedger(plugin, { clock });

    const pending = ledger.pendingRelease(claimsWork);
    expect(pending.total).toBe(0);
    expect(pending.byMarker).toEqual([]);
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
