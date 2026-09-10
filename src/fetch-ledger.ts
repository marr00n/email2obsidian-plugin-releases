import { Plugin } from 'obsidian';
import type { EmailSummary } from './api';
import { prefixedWarn } from './sync-report';

/* -------------------------------------------------------------------------
 * Fetch Ledger
 *
 * Owns which emails this install has already dealt with — accepted (a note was
 * written) or declined (ADR-0002: this install's receive policy turned it
 * down) — and the one invariant that makes the newest-first scan cheap:
 *
 *   THE LEDGER IS A CONTIGUOUS RUN OF THE NEWEST EMAILS, DECLINES INCLUDED.
 *
 * The service returns summaries newest-first. If every email older than the
 * newest ledger entry is itself in the ledger, then the first already-seen id
 * on a page means every email past it is known too, and the scan can stop
 * there (`shouldStopScan`). Recording declines is what keeps that true: a
 * ledger of accepts only goes sparse, and a page made entirely of declined
 * email holds no seen id at all — the scan would run on past it, in the worst
 * case through the whole history.
 *
 * Everything that can punch a hole in that contiguous run is therefore a
 * decision this module makes, not the caller:
 *
 *   - fetch-new, rate limited: the accepted ids are a *prefix* of the newest
 *     emails (the run works newest-first and stops where the limit hit), so
 *     appending them keeps the run contiguous and is written deliberately.
 *   - fetch-all, rate limited: a rewrite would replace the whole ledger with
 *     the handful of emails the run reached, discarding older accepted ids and
 *     tearing a hole in the middle of the run. Nothing is written at all.
 *
 * Storage: one top-level `fetch-log` key inside `plugin.saveData`'s envelope,
 * shared with `settings` — both readers spread what is already there and write
 * only their own key, so neither clobbers the other. Entries keep the shape
 * they have always had (`fetchedAt`, optional `filename`); a decline adds
 * `status: 'declined'`. An entry with no `status` — every entry any previous
 * version of the plugin ever wrote — is accepted.
 * ---------------------------------------------------------------------- */

/** The two disciplines a run commits under. */
export type SyncMode = 'fetch-new' | 'fetch-all';

export interface LedgerEntry {
  fetchedAt: string;
  filename?: string;
  /** Absent — the shape every pre-decline log has — means accepted. */
  status?: 'declined';
}

export type LedgerData = Record<string, LedgerEntry>;

export interface CommitOptions {
  mode: SyncMode;
  /**
   * The run stopped before it had worked through everything it selected
   * (today: a rate limit), so what it accepted is a prefix, not the whole run.
   */
  cutShort: boolean;
}

export interface Ledger {
  /** Has this install already accepted or declined this email? */
  hasSeen(id: number): boolean;
  /**
   * Newest-first pagination stops on the page this returns true for: it holds
   * an email we have already dealt with, so everything older is known.
   */
  shouldStopScan(page: EmailSummary[]): boolean;
  /** A note was written for this email. */
  accept(id: number, filename: string): void;
  /** The receive policy turned this email down (ADR-0002). */
  decline(id: number): void;
  /**
   * Drop every declined id, here and on disk, so a changed receive policy
   * reconsiders them on the next ordinary fetch-new (ADR-0002).
   */
  forgetDeclines(): void;
  /** Persist the run. */
  commit(options: CommitOptions): Promise<void>;
}

export interface OpenLedgerOptions {
  /** Injectable for tests; stamps `fetchedAt` on new entries. */
  clock?: () => string;
  /**
   * Where a load failure is reported. Defaults to the same prefixed
   * `console.warn` this has always used, so callers that don't pass one see
   * no change; `runSync` passes `report.warn` so the failure narrates
   * through the sync's one seam instead.
   */
  warn?: (msg: string, ...details: unknown[]) => void;
}

const FETCH_LOG_KEY = 'fetch-log';

export async function openLedger(
  plugin: Plugin,
  options: OpenLedgerOptions = {}
): Promise<Ledger> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const warn = options.warn ?? prefixedWarn;
  return new FetchLedger(plugin, await loadLedger(plugin, warn), clock);
}

class FetchLedger implements Ledger {
  private readonly plugin: Plugin;
  private readonly clock: () => string;
  /** What the last commit (or this install's history) left on disk. */
  private stored: LedgerData;
  /** What this run has decided, in the order it decided it. */
  private pending = new Map<string, LedgerEntry>();
  /** `forgetDeclines` makes a write worthwhile even with nothing accepted. */
  private forgotten = false;

  constructor(plugin: Plugin, stored: LedgerData, clock: () => string) {
    this.plugin = plugin;
    this.stored = stored;
    this.clock = clock;
  }

  hasSeen(id: number): boolean {
    const key = String(id);
    return this.pending.has(key) || this.stored[key] !== undefined;
  }

  shouldStopScan(page: EmailSummary[]): boolean {
    return page.some((email) => this.hasSeen(email.id));
  }

  accept(id: number, filename: string): void {
    this.pending.set(String(id), { fetchedAt: this.clock(), filename });
  }

  decline(id: number): void {
    this.pending.set(String(id), { fetchedAt: this.clock(), status: 'declined' });
  }

  forgetDeclines(): void {
    for (const [key, entry] of Array.from(this.pending)) {
      if (entry.status === 'declined') this.pending.delete(key);
    }
    for (const [key, entry] of Object.entries(this.stored)) {
      if (entry.status === 'declined') delete this.stored[key];
    }
    this.forgotten = true;
  }

  async commit({ mode, cutShort }: CommitOptions): Promise<void> {
    if (mode === 'fetch-all') {
      // A rewrite from a run that never finished would drop every id the run
      // did not reach. Leave the ledger exactly as it was.
      if (cutShort) return;
      await this.write(this.snapshot());
      return;
    }

    // fetch-new appends. A cut-short run still writes: newest-first means the
    // accepted ids are a contiguous prefix, and logging them is what stops the
    // next run from fetching them again.
    if (!this.pending.size && !this.forgotten) return;
    await this.write({ ...this.stored, ...this.snapshot() });
  }

  private snapshot(): LedgerData {
    const next: LedgerData = {};
    for (const [key, entry] of Array.from(this.pending)) {
      next[key] = entry;
    }
    return next;
  }

  private async write(log: LedgerData): Promise<void> {
    const existing: unknown = await this.plugin.loadData();
    const payload = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      [FETCH_LOG_KEY]: log,
    };
    await this.plugin.saveData(payload);
    this.stored = log;
    this.pending = new Map();
    this.forgotten = false;
  }
}

async function loadLedger(
  plugin: Plugin,
  warn: (msg: string, ...details: unknown[]) => void
): Promise<LedgerData> {
  try {
    const raw: unknown = await plugin.loadData();
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    const envelope = raw as Record<string, unknown>;
    const stored = envelope[FETCH_LOG_KEY];
    if (!stored || typeof stored !== 'object') {
      return {};
    }
    const parsed = stored as Record<string, unknown>;
    const log: LedgerData = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Record<string, unknown>;
      if (typeof entry.fetchedAt !== 'string') continue;
      const filename =
        typeof entry.filename === 'string' && entry.filename.length > 0
          ? entry.filename
          : undefined;
      // Anything but the decline marker — including its absence, which is all
      // an older plugin version ever wrote — is an accepted entry.
      log[key] =
        entry.status === 'declined'
          ? { fetchedAt: entry.fetchedAt, status: 'declined' }
          : { fetchedAt: entry.fetchedAt, filename };
    }
    return log;
  } catch (error) {
    warn(`Failed to load fetch ledger via plugin data: ${(error as Error).message}`);
    return {};
  }
}
