/* global setTimeout */
import { Vault, TFile, FileManager } from 'obsidian';
import { ApiError } from './api';
import type { AttachmentDownload, AttachmentMeta, DownloadAttachment } from './api';
import { basename, extname } from './path-utils';
import { mapWithConcurrency } from './concurrency';
import type { SyncReport } from './sync-report';

export interface SaveAttachmentsOptions {
  vault: Vault;
  fileManager: FileManager;
  sourcePath: string;
  /**
   * Non-inline attachments only. The caller partitions the email's attachment
   * list once (see `writeEmailNote`); anything passed here is downloaded and
   * saved, inline or not.
   */
  nonInlineAttachments: AttachmentMeta[];
  /** Where per-file failures are warned. Use `silentSyncReport()` to say nothing. */
  report: SyncReport;
  /** The Service Client's `downloadAttachment`; credentials live in the client. */
  downloader: DownloadAttachment;
  /** How the retry pause is taken. Injectable so tests need not really wait. */
  sleep?: Sleep;
}

export type Sleep = (ms: number) => Promise<void>;

export interface SaveAttachmentsResult {
  errors: AttachmentSaveError[];
  savedPathById: Record<number, string>;
}

export type AttachmentSaveContext = AttachmentMeta | InlineAttachmentContext;

export interface AttachmentSaveError {
  context: AttachmentSaveContext;
  message: string;
}

export interface InlineAttachmentContext {
  emailId: number;
  placeholderIndex: number;
  mimeType?: string | null;
  dataUriSnippet?: string;
  altText?: string | null;
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

export function buildAttachmentBase(opts: {
  source: 'inline' | 'api';
  emailId: number;
  index: number;
  suggestedName?: string | null;
  mimeType?: string | null;
}): string {
  const { source, emailId, index, suggestedName, mimeType } = opts;
  const fallbackPrefix = source === 'api' ? 'attachment' : 'inline';
  const fallback = `${fallbackPrefix}-${emailId}-${index}`;
  const mimeExt = getExtensionForMime(mimeType);

  if (suggestedName && suggestedName.trim().length) {
    const sanitized = sanitizeAttachmentName(suggestedName);
    const ext = extname(sanitized);
    if (ext && ext.length) {
      return sanitized;
    }
    return `${sanitized}${mimeExt}`;
  }

  return `${fallback}${mimeExt}`;
}

export function getExtensionForMime(mime?: string | null): string {
  if (!mime || typeof mime !== 'string') {
    return '.bin';
  }
  const normalized = mime.split(';')[0]?.trim().toLowerCase();
  if (!normalized) {
    return '.bin';
  }
  return MIME_EXTENSION_MAP[normalized] ?? '.bin';
}

export function toAttachmentSaveError(
  context: AttachmentSaveContext,
  err: unknown
): AttachmentSaveError {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unknown attachment error';
  return { context, message };
}

export async function saveBinaryData(opts: {
  vault: Vault;
  fileManager: FileManager;
  data: ArrayBuffer;
  suggestedName: string;
  sourcePath: string;
  mimeType?: string | null;
}): Promise<{ filename: string; path: string }> {
  const { vault, fileManager, data, suggestedName, sourcePath, mimeType } = opts;

  const sanitized = sanitizeAttachmentName(suggestedName);
  const providedExt = extname(sanitized);
  const extension = providedExt || getExtensionForMime(mimeType);
  const base = basename(sanitized, providedExt);

  const path = await fileManager.getAvailablePathForAttachment(
    `${base}${extension}`,
    sourcePath
  );
  await writeBinaryFile(vault, path, data);

  return { filename: basename(path), path };
}

/**
 * How long to wait before each retry of a rate-limited download. Two retries,
 * then the run gives up on the service rather than on the file.
 */
const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 3000];

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'rate-limited';
}

/**
 * Download and save the given (already non-inline) attachments to the vault,
 * collision-proofing filenames. Targets the attachment folder when provided,
 * otherwise the note folder. The note at `sourcePath` must already exist —
 * Obsidian resolves relative attachment locations against it.
 *
 * ## A rate limit is the run's problem, not the file's
 *
 * Every other download failure is per-file: it is reported, the note is
 * written with the link it can manage, and the email counts as done. A rate
 * limit cannot be treated that way. The service is asking the whole run to
 * slow down, so skipping the file would write a note with a broken link, mark
 * the email as imported — a re-fetch will never repair it — and carry on
 * hammering the service for every attachment after it.
 *
 * So a rate-limited download is retried after a pause, and if it is still
 * rate limited it is thrown, out through `writeEmailNote` to `runSync`, which
 * stops the run and leaves the email unrecorded for the next one.
 */
export async function saveAttachments(
  opts: SaveAttachmentsOptions
): Promise<SaveAttachmentsResult> {
  const {
    vault,
    fileManager,
    nonInlineAttachments,
    sourcePath,
    report,
    downloader,
    sleep = defaultSleep,
  } = opts;

  const errors: AttachmentSaveError[] = [];
  const savedPathById: Record<number, string> = {};

  // Held rather than thrown from inside the worker: a second worker throwing
  // after the pool has already rejected would have nowhere to land. Once set,
  // `shouldStop` keeps the pool from starting any download it has not begun,
  // and the run is abandoned below.
  let rateLimit: unknown = null;

  const downloads = await mapWithConcurrency(
    nonInlineAttachments,
    3,
    async (att, index) => {
      const baseName = buildAttachmentBase({
        source: 'api',
        emailId: att.id,
        index,
        suggestedName: att.fileName,
        mimeType: att.mimeType,
      });

      try {
        const downloaded = await downloadWithRetry({
          downloader,
          att,
          baseName,
          report,
          sleep,
        });
        return { att, baseName, downloaded };
      } catch (error) {
        if (isRateLimited(error)) {
          rateLimit = error;
          return null;
        }
        const errObj = toAttachmentSaveError(att, error);
        report.warn(`Attachment ${att.id}: ${errObj.message}`);
        errors.push(errObj);
        return null;
      }
    },
    { shouldStop: () => rateLimit !== null }
  );

  if (rateLimit) throw rateLimit;

  for (const item of downloads) {
    if (!item || !item.downloaded) continue;
    const { att, baseName, downloaded } = item;

    try {
      const saved = await saveBinaryData({
        vault,
        data: downloaded.data,
        suggestedName: baseName,
        fileManager,
        sourcePath,
        mimeType: downloaded.mimeType,
      });
      savedPathById[att.id] = saved.path;
    } catch (error) {
      const errObj = toAttachmentSaveError(att, error);
      report.warn(`Attachment ${att.id}: ${errObj.message}`);
      errors.push(errObj);
    }
  }

  return { errors, savedPathById };
}

/**
 * One attachment's download, retried while the service is asking for a pause.
 * Any other failure is handed straight back to the caller, which reports it
 * per file; a rate limit that outlasts every retry is handed back too, and
 * the caller treats that one as the end of the run.
 */
async function downloadWithRetry(opts: {
  downloader: DownloadAttachment;
  att: AttachmentMeta;
  baseName: string;
  report: SyncReport;
  sleep: Sleep;
}): Promise<AttachmentDownload> {
  const { downloader, att, baseName, report, sleep } = opts;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await downloader(att.id, baseName);
    } catch (error) {
      const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      if (!isRateLimited(error) || delay === undefined) throw error;
      report.debug(
        `Attachment ${att.id}: rate limited, retrying in ${delay}ms (attempt ${attempt + 1})`
      );
      await sleep(delay);
    }
  }
}

function sanitizeAttachmentName(name: string, id?: number): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return typeof id === 'number' ? `attachment-${id}` : 'attachment';
  }
  const ext = extname(cleaned);
  const base = basename(cleaned, ext);
  return `${base}${ext}`;
}

async function writeBinaryFile(
  vault: Vault,
  filePath: string,
  data: ArrayBuffer
): Promise<void> {
  const existing = vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    await vault.modifyBinary(existing, data);
    return;
  }
  await vault.createBinary(filePath, data);
}
