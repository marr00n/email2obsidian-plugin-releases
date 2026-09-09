/* global console */
import { normalizePath, Notice, Plugin, Vault, TFile } from 'obsidian';
import { ApiError, type E2oClient, type EmailSummary } from './api';
import { openLedger, type SyncMode } from './fetch-ledger';
import { renderEmailMarkdown } from './helpers';
import { openNoteNames } from './note-namer';
import {
  saveAttachments,
  SaveAttachmentsResult,
  ensureFolder,
  AttachmentSaveError,
  saveBinaryData,
} from './attachments';
import { basename, isRootPath } from './path-utils';
export interface PipelineSettings {
  apiKey: string;
  notesFolder: string;
  debugLogging?: boolean;
}

export type { SyncMode };

export interface SyncOptions {
  mode: SyncMode;
  settings: PipelineSettings;
  vault: Vault;
  plugin: Plugin;
  /** The Service Client to read through; it already holds the API key. */
  client: E2oClient;
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
  attachmentErrors: AttachmentSaveError[];
  rateLimited: boolean;
}

export async function runSync(
  opts: SyncOptions,
  notifier: (msg: string) => void = (msg) => new Notice(msg)
): Promise<SyncResult> {
  const { settings, vault, plugin, mode, client } = opts;
  const debugLog = createDebugLogger(Boolean(settings.debugLogging));
  if (!settings.apiKey.trim()) {
    throw new Error('Add your Email2Obsidian API key in Settings before syncing.');
  }

  const rawNoteFolder = settings.notesFolder ?? '';
  const noteFolderIsRoot = isRootPath(rawNoteFolder);
  const noteFolder = noteFolderIsRoot ? '' : normalizePath(rawNoteFolder);
  if (!noteFolderIsRoot) {
    await ensureFolder(vault, noteFolder);
  }

  const namerStart = Date.now();
  const namer = await openNoteNames(vault, noteFolder);
  debugLog(`openNoteNames in ${Date.now() - namerStart}ms`);

  const ledger = await openLedger(plugin);

  const { emails: emailSummaries, stoppedEarly } = await paginateEmails(client, debugLog, {
    // fetch-all wants the whole stream; only fetch-new leans on the ledger's
    // contiguity to stop scanning.
    stopWhen:
      mode === 'fetch-new' ? (page) => ledger.shouldStopScan(page) : undefined,
  });

  const selected = mode === 'fetch-all'
    ? emailSummaries
    : emailSummaries.filter((email) => !ledger.hasSeen(email.id));

  const skipped = mode === 'fetch-new' ? emailSummaries.length - selected.length : 0;
  debugLog(
    `selection: mode=${mode}, total summaries=${emailSummaries.length}, selected=${selected.length}, skipped=${skipped}, stoppedEarly=${stoppedEarly}`
  );

  let accepted = 0;
  const errors: string[] = [];
  const attachmentErrors: AttachmentSaveError[] = [];
  let rateLimitedError: ApiError | null = null;

  await runWithConcurrency(
    selected,
    2,
    async (summary) => {
      if (rateLimitedError) return;
      try {
        const fetchStart = Date.now();
        const detail = await client.getEmail(summary.id);
        debugLog(
          `getEmail ${summary.id} fetched in ${Date.now() - fetchStart}ms (attachments: ${
            detail.attachments?.length ?? 0
          })`
        );

        const notePath = namer.reserve(detail.subject, detail.createdAt);

        // Create the note before saving attachments so Obsidian can resolve
        // relative attachment paths ("Same folder as current file", etc.).
        await writeOrCreateNote(vault, notePath, '');

        const saveStart = Date.now();
        const savedAttachments: SaveAttachmentsResult = await saveAttachments({
          vault,
          fileManager: plugin.app.fileManager,
          attachments: detail.attachments || [],
          sourcePath: notePath,
          logger: (msg) => console.warn(msg),
          downloader: (id, expectedFileName) =>
            client.downloadAttachment(id, expectedFileName),
        });
        debugLog(
          `saveAttachments for email ${detail.id} completed in ${Date.now() - saveStart}ms; saved ${
            Object.keys(savedAttachments.savedPathById).length
          } attachments`
        );

        attachmentErrors.push(...savedAttachments.errors);

        const renderStart = Date.now();
        const renderResult = await renderEmailMarkdown(
          detail,
          {
            noteFolder,
          },
          {
            savedPaths: savedAttachments.savedPathById,
            inlineSaver: (opts) =>
              saveBinaryData({
                vault,
                fileManager: plugin.app.fileManager,
                data: opts.data,
                suggestedName: opts.suggestedName,
                sourcePath: notePath,
                mimeType: opts.mimeType,
              }),
          }
        );
        debugLog(
          `renderEmailMarkdown for email ${detail.id} in ${Date.now() - renderStart}ms (inline embeds: ${
            Object.keys(renderResult.inlineEmbeds).length
          }, inline errors: ${renderResult.inlineErrors.length})`
        );

        const markdown = renderResult.markdown;
        attachmentErrors.push(...renderResult.inlineErrors);

        const writeStart = Date.now();
        await writeOrCreateNote(vault, notePath, markdown);
        debugLog(`writeOrCreateNote ${notePath || '(root)'} in ${Date.now() - writeStart}ms`);

        ledger.accept(detail.id, basename(notePath));
        accepted += 1;
      } catch (error: unknown) {
        if (error instanceof ApiError && error.code === 'rate-limited') {
          rateLimitedError = error;
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : 'Something went wrong syncing an email.';
        console.warn(`[Email2Obsidian] ${message}`);
        errors.push(message);
        return;
      }
    }
  );

  if (rateLimitedError) {
    const message =
      "You've hit the rate limit. Please wait a bit or lower the sync frequency.";
    notifier(message);
    console.warn(`[Email2Obsidian] ${message}`);
    await ledger.commit({ mode, cutShort: true });
    return {
      synced: accepted,
      skipped,
      errors,
      attachmentErrors,
      rateLimited: true,
    };
  }

  const commitStart = Date.now();
  await ledger.commit({ mode, cutShort: false });
  debugLog(
    `fetch ledger committed (${mode}) with ${accepted} entries in ${Date.now() - commitStart}ms`
  );

  notifier(
    `Email2Obsidian Sync summary: ${accepted} added, ${skipped} skipped, ${errors.length} errors, ${attachmentErrors.length} attachment issues.`
  );

  return {
    synced: accepted,
    skipped,
    errors,
    attachmentErrors,
    rateLimited: false,
  };
}

/**
 * Walks the newest-first stream of summaries. `stopWhen` is asked, page by
 * page, whether the scan has reached email this install already knows about;
 * omit it to read the stream to its end.
 */
async function paginateEmails(
  client: E2oClient,
  log?: (msg: string) => void,
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
    log?.(
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
      console.warn(
        '[Email2Obsidian] The service reported more emails but sent no cursor; stopping the scan here.'
      );
      break;
    }
  }

  log?.(
    `paginateEmails completed ${emails.length} emails across ${page} pages in ${
      Date.now() - started
    }ms`
  );
  return { emails, stoppedEarly };
}

async function writeOrCreateNote(
  vault: Vault,
  path: string,
  contents: string
): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await vault.process(existing, () => contents);
    return;
  }
  await vault.create(path, contents);
}

function createDebugLogger(enabled: boolean): (msg: string) => void {
  if (!enabled) {
    return () => {};
  }
  return (msg: string) => {
    console.debug(`[Email2Obsidian][debug] ${msg}`);
  };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index;
      if (current >= items.length) break;
      index += 1;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}
