/* global console */
import { normalizePath, Notice, Plugin, Vault, TFile } from 'obsidian';
import { ApiError, type E2oClient, type EmailSummary } from './api';
import {
  appendFetchLog,
  loadFetchLog,
  rewriteFetchLog,
  writeFetchLog,
  FetchLogInput,
} from './fetch-log-store';
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

export type SyncMode = 'fetch-new' | 'fetch-all';

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

  const fetchLog = await loadFetchLog(plugin);
  const loggedIds = new Set(Object.keys(fetchLog));

  const { emails: emailSummaries, stoppedEarly } = await paginateEmails(client, debugLog, {
    stopOnLogged: mode === 'fetch-new' ? loggedIds : undefined,
  });

  const selected = mode === 'fetch-all'
    ? emailSummaries
    : emailSummaries.filter((email) => !loggedIds.has(String(email.id)));

  const skipped = mode === 'fetch-new' ? emailSummaries.length - selected.length : 0;
  debugLog(
    `selection: mode=${mode}, total summaries=${emailSummaries.length}, selected=${selected.length}, skipped=${skipped}, stoppedEarly=${stoppedEarly}`
  );

  const successes: FetchLogInput[] = [];
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

        successes.push({
          id: detail.id,
          filename: basename(notePath),
        });
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
    if (mode === 'fetch-new' && successes.length) {
      const nextLog = appendFetchLog(fetchLog, successes);
      await writeFetchLog(plugin, nextLog);
    }
    return {
      synced: successes.length,
      skipped,
      errors,
      attachmentErrors,
      rateLimited: true,
    };
  }

  if (mode === 'fetch-new') {
    if (successes.length) {
      const nextLog = appendFetchLog(fetchLog, successes);
      const writeLogStart = Date.now();
      await writeFetchLog(plugin, nextLog);
      debugLog(`fetch log updated with ${successes.length} entries in ${Date.now() - writeLogStart}ms`);
    }
  } else {
    const nextLog = rewriteFetchLog(successes);
    const writeLogStart = Date.now();
    await writeFetchLog(plugin, nextLog);
    debugLog(`fetch log rewritten with ${successes.length} entries in ${Date.now() - writeLogStart}ms`);
  }

  notifier(
    `Email2Obsidian Sync summary: ${successes.length} added, ${skipped} skipped, ${errors.length} errors, ${attachmentErrors.length} attachment issues.`
  );

  return {
    synced: successes.length,
    skipped,
    errors,
    attachmentErrors,
    rateLimited: false,
  };
}

async function paginateEmails(
  client: E2oClient,
  log?: (msg: string) => void,
  options: { stopOnLogged?: Set<string> } = {}
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
    emails.push(...(response.emails || []));

    if (options.stopOnLogged && response.emails?.some((e) => options.stopOnLogged?.has(String(e.id)))) {
      stoppedEarly = true;
      break;
    }

    hasMore = Boolean(response.hasMore);
    cursor = response.nextCursor ?? undefined;
    page += 1;
    if (!hasMore) break;
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
