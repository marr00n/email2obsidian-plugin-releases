/* global console */
import { normalizePath, Notice, Plugin, Vault, TFile } from 'obsidian';
import { getEmail, listEmails, EmailSummary, ApiError } from './api';
import {
  appendFetchLog,
  loadFetchLog,
  rewriteFetchLog,
  writeFetchLog,
  FetchLogInput,
} from './fetch-log-store';
import { renderEmailMarkdown, safeFilename, type FilenameResult } from './helpers';
import {
  saveAttachments,
  SaveAttachmentsResult,
  ensureFolder,
  AttachmentSaveError,
  saveBinaryData,
} from './attachments';
import { joinPosix, isRootPath } from './path-utils';
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
  const { settings, vault, plugin, mode } = opts;
  const debugLog = createDebugLogger(Boolean(settings.debugLogging));
  const apiKey = settings.apiKey.trim();
  if (!apiKey) {
    throw new Error('Add your Email2Obsidian API key in Settings before syncing.');
  }

  const rawNoteFolder = settings.notesFolder ?? '';
  const noteFolderIsRoot = isRootPath(rawNoteFolder);
  const noteFolder = noteFolderIsRoot ? '' : normalizePath(rawNoteFolder);
  if (!noteFolderIsRoot) {
    await ensureFolder(vault, noteFolder);
  }

  const existingScanStart = Date.now();
  const existingNames = await loadExistingNoteNames(vault, noteFolder, { shallow: true });
  debugLog(
    `loadExistingNoteNames in ${Date.now() - existingScanStart}ms (found ${existingNames.size})`
  );

  const fetchLog = await loadFetchLog(plugin);
  const loggedIds = new Set(Object.keys(fetchLog));

  const { emails: emailSummaries, stoppedEarly } = await paginateEmails(apiKey, debugLog, {
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

  const nameLock = createMutex();

  await runWithConcurrency(
    selected,
    2,
    async (summary) => {
      if (rateLimitedError) return;
      try {
        const fetchStart = Date.now();
        const detail = await getEmail(summary.id, apiKey);
        debugLog(
          `getEmail ${summary.id} fetched in ${Date.now() - fetchStart}ms (attachments: ${
            detail.attachments?.length ?? 0
          })`
        );

        const filenameResult: FilenameResult = await nameLock(async () => {
          const res = safeFilename(detail.subject, detail.createdAt, existingNames);
          existingNames.add(res.filename);
          return res;
        });

        const notePath = joinPosix(noteFolder, filenameResult.filename);

        const saveStart = Date.now();
        const savedAttachments: SaveAttachmentsResult = await saveAttachments({
          vault,
          fileManager: plugin.app.fileManager,
          apiKey,
          attachments: detail.attachments || [],
          sourcePath: notePath,
          logger: (msg) => console.warn(msg),
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
          filename: filenameResult.filename,
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
  apiKey: string,
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
    const response = await listEmails({ apiKey, cursor, sort: 'date-desc' });
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

async function loadExistingNoteNames(
  vault: Vault,
  noteFolder: string,
  options: { shallow?: boolean } = {}
): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const folder = noteFolder.length ? vault.getFolderByPath(noteFolder) : vault.getRoot();
    if (!folder) {
      return names;
    }
    for (const child of folder.children) {
      if (child instanceof TFile) {
        names.add(child.name);
      }
      // We intentionally skip subfolders to keep scans cheap on large vaults.
      // If recursive scanning is ever needed, it can be added behind the shallow flag.
    }
  } catch (error: unknown) {
    // ignore missing folder; it will be created elsewhere
    console.warn(
      `[Email2Obsidian] Unable to list folder ${
        noteFolder.length ? noteFolder : 'vault root'
      }: ${(error as Error).message}`
    );
  }
  return names;
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

function createMutex() {
  let current = Promise.resolve();
  return async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const result = current.then(() => fn());
    current = result.then(
      () => Promise.resolve(),
      () => Promise.resolve()
    );
    return result;
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
