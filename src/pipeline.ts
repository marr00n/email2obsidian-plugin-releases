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

export interface PipelineSettings {
  apiKey: string;
  notesFolder: string;
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
  const namer = await openNoteNames(vault, noteFolder.path);
  report.debug(`openNoteNames in ${Date.now() - namerStart}ms`);

  const ledger = await openLedger(plugin);

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
    selected,
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
    return { synced: accepted, skipped, errors, attachmentErrors };
  }

  const commitStart = Date.now();
  await ledger.commit({ mode, cutShort: false });
  report.debug(
    `fetch ledger committed (${mode}) with ${accepted} entries in ${Date.now() - commitStart}ms`
  );

  report.notice(
    `Email2Obsidian Sync summary: ${accepted} added, ${skipped} skipped, ${errors.length} errors, ${attachmentErrors.length} attachment issues.`
  );

  return { synced: accepted, skipped, errors, attachmentErrors };
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
