import { Plugin, Vault } from 'obsidian';
import { ApiError, type E2oClient, type EmailSummary } from './api';
import { openLedger, type SyncMode } from './fetch-ledger';
import { openNoteNames } from './note-namer';
import { AttachmentSaveError } from './attachments';
import { writeEmailNote, type WriteEmailNoteContext } from './write-email-note';
import { resolveNoteFolder } from './note-folder';
import { basename } from './path-utils';
import { mapWithConcurrency } from './concurrency';
import { silentSyncReport, type SyncReport } from './sync-report';
import {
  hasStarterSignature,
  receivePolicyFor,
  tallyMarkers,
  type MarkerCount,
} from './receive-policy';

export interface PipelineSettings {
  apiKey: string;
  notesFolder: string;
  /**
   * The Vault Markers this Obsidian Vault claims. Absent or empty is *no
   * marker filter* — every marked email is claimed — which is what makes an
   * install that has never seen this feature behave exactly as it always did.
   */
  vaultMarkers?: string[];
  /** Whether Unmarked Email is claimed. Absent means yes, as it always was. */
  receiveUnmarked?: boolean;
}

export type { SyncMode };

export interface SyncOptions {
  mode: SyncMode;
  settings: PipelineSettings;
  vault: Vault;
  plugin: Plugin;
  /** The Service Client to read through; it already holds the API key. */
  client: E2oClient;
  /**
   * Where this run's toasts, warnings and debug lines go. Omit it and the run
   * says nothing at all — which is what a test wants, and never what the
   * plugin wants, so `main.ts` always supplies one.
   */
  report?: SyncReport;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  /** Emails this run turned away because they were not for this vault. */
  declined: number;
  /** Which Vault Markers they arrived under, commonest first. */
  declinedByMarker: MarkerCount[];
  /**
   * The run saw an email the service left unmarked whose subject still
   * carries its `@@` token — the one signature of an account without vault
   * routing. A flag for settings to explain, nothing more (ADR 0001).
   */
  starterSignature: boolean;
  errors: string[];
  attachmentErrors: AttachmentSaveError[];
}

/** What one worker's attempt at a single email came out as. */
type EmailSyncOutcome =
  | { status: 'accepted'; attachmentErrors: AttachmentSaveError[] }
  | { status: 'error'; message: string }
  | { status: 'rate-limited' };

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const { settings, vault, plugin, mode, client } = opts;
  const report = opts.report ?? silentSyncReport();
  if (!settings.apiKey.trim()) {
    throw new Error('Add your Email2Obsidian API key in Settings before syncing.');
  }

  const noteFolder = await resolveNoteFolder(vault, settings.notesFolder ?? '');

  const namerStart = Date.now();
  const namer = await openNoteNames(vault, noteFolder.path, {
    warn: (msg, ...details) => report.warn(msg, ...details),
  });
  report.debug(`openNoteNames in ${Date.now() - namerStart}ms`);

  const ledger = await openLedger(plugin, {
    warn: (msg, ...details) => report.warn(msg, ...details),
  });

  const policy = receivePolicyFor(settings);

  // Recovery is the sync's job, not the settings panel's: whatever this
  // install's markers say *now* is read against what each decline recorded,
  // so a correction typed on one device takes effect on whichever device next
  // syncs, and there is one code path that can be wrong rather than two.
  // fetch-all re-reads everything anyway and rewrites the ledger from scratch.
  if (mode === 'fetch-new') {
    const released = ledger.release(policy);
    if (released) {
      report.debug(`receive policy released ${released} previously declined emails`);
    }
  }

  const { emails: emailSummaries, stoppedEarly } = await paginateEmails(client, report, {
    // fetch-all wants the whole stream; only fetch-new leans on the ledger's
    // contiguity to stop scanning.
    stopWhen:
      mode === 'fetch-new' ? (page) => ledger.shouldStopScan(page) : undefined,
  });

  const selected = mode === 'fetch-all'
    ? emailSummaries
    : emailSummaries.filter((email) => !ledger.hasSeen(email.id));

  const skipped = mode === 'fetch-new' ? emailSummaries.length - selected.length : 0;
  report.debug(
    `selection: mode=${mode}, total summaries=${emailSummaries.length}, selected=${selected.length}, skipped=${skipped}, stoppedEarly=${stoppedEarly}`
  );

  // The receive decision is made here, on the summary, before any detail
  // request: a declined email must cost no body and no attachment download.
  const claimed: EmailSummary[] = [];
  const declinedMarkers: (string | null)[] = [];
  let starterSignature = false;
  for (const summary of selected) {
    if (hasStarterSignature(summary)) starterSignature = true;
    if (policy.claims(summary.vaultMarker)) {
      claimed.push(summary);
      continue;
    }
    ledger.decline(summary.id, summary.vaultMarker);
    declinedMarkers.push(summary.vaultMarker);
  }

  const declinedByMarker = tallyMarkers(declinedMarkers);
  report.debug(
    `receive policy: claimed=${claimed.length}, declined=${declinedMarkers.length}`
  );

  const noteContext: WriteEmailNoteContext = {
    vault,
    fileManager: plugin.app.fileManager,
    namer,
    noteFolder: noteFolder.path,
    downloadAttachment: (id, expectedFileName) =>
      client.downloadAttachment(id, expectedFileName),
    report,
  };

  // Flipped by a worker the instant it hits a 429; read back by the pool
  // before it starts each not-yet-started item, so anything not already in
  // flight is skipped while in-flight work still finishes.
  let rateLimited = false;

  const outcomes = await mapWithConcurrency<EmailSummary, EmailSyncOutcome>(
    claimed,
    2,
    async (summary) => {
      try {
        const fetchStart = Date.now();
        const detail = await client.getEmail(summary.id);
        report.debug(
          `getEmail ${summary.id} fetched in ${Date.now() - fetchStart}ms (attachments: ${
            detail.attachments?.length ?? 0
          })`
        );

        const written = await writeEmailNote(noteContext, detail);
        ledger.accept(detail.id, basename(written.notePath));
        return { status: 'accepted', attachmentErrors: written.attachmentErrors };
      } catch (error: unknown) {
        if (error instanceof ApiError && error.code === 'rate-limited') {
          rateLimited = true;
          return { status: 'rate-limited' };
        }
        const message =
          error instanceof Error
            ? error.message
            : 'Something went wrong syncing an email.';
        report.warn(message);
        return { status: 'error', message };
      }
    },
    { shouldStop: () => rateLimited }
  );

  let accepted = 0;
  const errors: string[] = [];
  const attachmentErrors: AttachmentSaveError[] = [];
  /** The run as it stands — the same shape whether it finished or was cut. */
  const result = (): SyncResult => ({
    synced: accepted,
    skipped,
    declined: declinedMarkers.length,
    declinedByMarker,
    starterSignature,
    errors,
    attachmentErrors,
  });
  for (const outcome of outcomes) {
    // Items the pool never started (skipped once `rateLimited` flipped) leave
    // a hole here.
    if (!outcome) continue;
    if (outcome.status === 'accepted') {
      accepted += 1;
      attachmentErrors.push(...outcome.attachmentErrors);
    } else if (outcome.status === 'error') {
      errors.push(outcome.message);
    }
  }

  if (rateLimited) {
    const message =
      "You've hit the rate limit. Please wait a bit or lower the sync frequency.";
    report.notice(message);
    report.warn(message);
    await ledger.commit({ mode, cutShort: true });
    return result();
  }

  const commitStart = Date.now();
  await ledger.commit({ mode, cutShort: false });
  report.debug(
    `fetch ledger committed (${mode}) with ${accepted} entries in ${Date.now() - commitStart}ms`
  );

  const summary = [
    `${accepted} added`,
    `${skipped} skipped`,
    // Only worth a clause when it happened: an install with one Obsidian
    // Vault never declines anything and should not be told so every run.
    ...(declinedMarkers.length ? [`${declinedMarkers.length} not for this vault`] : []),
    `${errors.length} errors`,
    `${attachmentErrors.length} attachment issues`,
  ].join(', ');
  report.notice(`Email2Obsidian Sync summary: ${summary}.`);

  return result();
}

/**
 * Walks the newest-first stream of summaries. `stopWhen` is asked, page by
 * page, whether the scan has reached email this install already knows about;
 * omit it to read the stream to its end.
 */
async function paginateEmails(
  client: E2oClient,
  report: SyncReport,
  options: { stopWhen?: (page: EmailSummary[]) => boolean } = {}
): Promise<{ emails: EmailSummary[]; stoppedEarly: boolean }> {
  const emails: EmailSummary[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  const started = Date.now();
  let page = 0;
  let stoppedEarly = false;

  while (hasMore) {
    const pageStart = Date.now();
    const response = await client.listEmails({ cursor, sort: 'date-desc' });
    report.debug(
      `paginateEmails page ${page} fetched ${response.emails?.length ?? 0} in ${
        Date.now() - pageStart
      }ms`
    );
    const pageEmails = response.emails || [];
    emails.push(...pageEmails);

    if (options.stopWhen?.(pageEmails)) {
      stoppedEarly = true;
      break;
    }

    hasMore = Boolean(response.hasMore);
    cursor = response.nextCursor ?? undefined;
    page += 1;
    if (!hasMore) break;
    if (!cursor) {
      // hasMore with no cursor would re-request page 0 forever.
      report.warn(
        'The service reported more emails but sent no cursor; stopping the scan here.'
      );
      break;
    }
  }

  report.debug(
    `paginateEmails completed ${emails.length} emails across ${page} pages in ${
      Date.now() - started
    }ms`
  );
  return { emails, stoppedEarly };
}
