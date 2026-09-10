import { Plugin } from 'obsidian';
import type { EmailSummary } from './api';
import { prefixedWarn } from './sync-report';
import {
  isUnmarked,
  tallyMarkers,
  UNMARKED_KEY,
  type MarkerCount,
  type ReceivePolicy,
} from './receive-policy';

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
 * A decline also records the Vault Marker the email arrived under, which is
 * what lets a later marker change release exactly the declines it now claims
 * (`release`) and answer, with no network request, how much mail that change
 * would bring in (`pendingRelease`). Because the marker is on the entry, the
 * ledger never has to remember which receive policy it was written under: the
 * current policy read against the recorded marker answers the question
 * directly, whichever device made the correction.
 *
 * Storage: one top-level `fetch-log` key inside `plugin.saveData`'s envelope,
 * shared with `settings` — both readers spread what is already there and write
 * only their own key, so neither clobbers the other. Entries keep the shape
 * they have always had (`fetchedAt`, optional `filename`); a decline adds
 * `status: 'declined'` and `vaultMarker`. An entry with no `status` — every
 * entry any previous version of the plugin ever wrote — is accepted.
 * ---------------------------------------------------------------------- */

/**
 * How long the service keeps a received email before deleting it
 * (`docs/server-api-contract.md`). Nothing older can be released, because
 * nothing older is still there to fetch.
 *
 * It also bounds the cost of everything here: a scan that reads the stream
 * out reads at most 72 hours of email, however far back the ledger goes.
 */
export const RETENTION_MS = 72 * 60 * 60 * 1000;

/** The two disciplines a run commits under. */
export type SyncMode = 'fetch-new' | 'fetch-all';

export interface LedgerEntry {
  fetchedAt: string;
  filename?: string;
  /** Absent — the shape every pre-decline log has — means accepted. */
  status?: 'declined';
  /**
   * On a decline, the Vault Marker the email arrived under — `''` for an
   * Unmarked Email, so "arrived unmarked" stays distinct from "not recorded".
   * Absent on an accepted entry, and on a decline written before the marker
   * was stored; such a decline cannot be ruled out and so is always released.
   */
  vaultMarker?: string;
}

/** What a proposed marker list would bring back in. */
export interface PendingRelease {
  total: number;
  byMarker: MarkerCount[];
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
  /**
   * The receive policy turned this email down (ADR-0002), under the Vault
   * Marker it arrived with — `null` for an Unmarked Email.
   */
  decline(id: number, vaultMarker: string | null): void;
  /**
   * Put back into play every decline this policy now claims and the service
   * could still hold, so this run imports them. Returns how many.
   *
   * Released ids stop counting as seen, so the run selects them — but they
   * stay in the ledger until it commits, and `shouldStopScan` keeps the scan
   * running until each one has been met again. Without that the early stop
   * would halt on newer email and never reach the very mail this run exists
   * to recover.
   */
  release(policy: ReceivePolicy): number;
  /**
   * How much declined mail a policy would release, and under which markers —
   * a read, changing nothing. This is what the settings panel asks while the
   * user is still typing, so it never touches the network.
   */
  pendingRelease(policy: ReceivePolicy): PendingRelease;
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
  /** Declines this run put back into play, still on disk until it commits. */
  private released = new Set<string>();
  /** Of those, the ones the scan has yet to run back far enough to meet. */
  private outstanding = new Set<string>();

  constructor(plugin: Plugin, stored: LedgerData, clock: () => string) {
    this.plugin = plugin;
    this.stored = stored;
    this.clock = clock;
  }

  hasSeen(id: number): boolean {
    const key = String(id);
    if (this.pending.has(key)) return true;
    if (this.released.has(key)) return false;
    return this.stored[key] !== undefined;
  }

  shouldStopScan(page: EmailSummary[]): boolean {
    for (const email of page) this.outstanding.delete(String(email.id));
    // A released id is exactly the mail this run went looking for, and it sits
    // further back than the newest email the scan opens on. Stopping at the
    // usual place would walk straight past it.
    if (this.outstanding.size) return false;
    return page.some((email) => this.recorded(email.id));
  }

  accept(id: number, filename: string): void {
    this.pending.set(String(id), { fetchedAt: this.clock(), filename });
  }

  decline(id: number, vaultMarker: string | null): void {
    this.pending.set(String(id), {
      fetchedAt: this.clock(),
      status: 'declined',
      vaultMarker: isUnmarked(vaultMarker) ? UNMARKED_KEY : vaultMarker,
    });
  }

  release(policy: ReceivePolicy): number {
    for (const [key] of this.releasable(policy)) {
      this.released.add(key);
      this.outstanding.add(key);
    }
    return this.released.size;
  }

  pendingRelease(policy: ReceivePolicy): PendingRelease {
    const markers = this.releasable(policy).map(([, entry]) => entry.vaultMarker);
    return { total: markers.length, byMarker: tallyMarkers(markers) };
  }

  /**
   * The declined entries this policy claims and the service could still be
   * holding, newest first. A decline with no recorded marker predates the
   * marker being stored and cannot be ruled out, so it always counts.
   *
   * Newest first because a tally over these keeps the first spelling of a
   * marker it meets, and the spelling the user should be shown is the one
   * their most recent email actually carried.
   */
  private releasable(policy: ReceivePolicy): [string, LedgerEntry][] {
    const cutoff = Date.parse(this.clock()) - RETENTION_MS;
    return Object.entries(this.stored)
      .filter(([, entry]) => {
        if (entry.status !== 'declined') return false;
        if (Date.parse(entry.fetchedAt) < cutoff) return false;
        return entry.vaultMarker === undefined || policy.claims(entry.vaultMarker);
      })
      .sort(([a], [b]) => Number(b) - Number(a));
  }

  /** In the ledger at all — released or not. What contiguity is about. */
  private recorded(id: number): boolean {
    const key = String(id);
    return this.pending.has(key) || this.stored[key] !== undefined;
  }

  async commit({ mode, cutShort }: CommitOptions): Promise<void> {
    if (mode === 'fetch-all') {
      // A rewrite from a run that never finished would drop every id the run
      // did not reach. Leave the ledger exactly as it was.
      if (cutShort) return;
      await this.write(this.snapshot());
      return;
    }

    // A run that finished and still did not meet a released id has proved the
    // service no longer holds it, and dropping the entry is what stops every
    // later run from reading the stream out in search of it. A run that was
    // cut short has proved nothing of the sort — it stopped, the service did
    // not — so its released entries stay exactly where they are, and the next
    // run releases and hunts them again.
    const missedAreGone = !cutShort;

    // fetch-new appends. A cut-short run still writes: newest-first means the
    // accepted ids are a contiguous prefix, and logging them is what stops the
    // next run from fetching them again.
    if (!this.pending.size && !(missedAreGone && this.released.size)) return;

    const base = { ...this.stored };
    if (missedAreGone) {
      for (const key of Array.from(this.released)) {
        if (!this.pending.has(key)) delete base[key];
      }
    }
    await this.write({ ...base, ...this.snapshot() });
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
    this.released = new Set();
    this.outstanding = new Set();
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
          ? {
              fetchedAt: entry.fetchedAt,
              status: 'declined',
              // Left undefined when the stored decline predates the marker
              // being recorded, which `releasable` reads as "cannot rule out".
              ...(typeof entry.vaultMarker === 'string'
                ? { vaultMarker: entry.vaultMarker }
                : {}),
            }
          : { fetchedAt: entry.fetchedAt, filename };
    }
    return log;
  } catch (error) {
    warn(`Failed to load fetch ledger via plugin data: ${(error as Error).message}`);
    return {};
  }
}
