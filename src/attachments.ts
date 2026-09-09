/* global console */
import { Vault, TFile, FileManager } from 'obsidian';
import type { AttachmentMeta, DownloadAttachment } from './api';
import { basename, extname } from './path-utils';
import { mapWithConcurrency } from './concurrency';

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
  logger?: (msg: string) => void;
  /** The Service Client's `downloadAttachment`; credentials live in the client. */
  downloader: DownloadAttachment;
}

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
 * Download and save the given (already non-inline) attachments to the vault,
 * collision-proofing filenames. Targets the attachment folder when provided,
 * otherwise the note folder. The note at `sourcePath` must already exist —
 * Obsidian resolves relative attachment locations against it.
 */
export async function saveAttachments(
  opts: SaveAttachmentsOptions
): Promise<SaveAttachmentsResult> {
  const {
    vault,
    fileManager,
    nonInlineAttachments,
    sourcePath,
    logger = console.warn,
    downloader,
  } = opts;

  const errors: AttachmentSaveError[] = [];
  const savedPathById: Record<number, string> = {};

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
        const downloaded = await downloader(att.id, baseName);
        return { att, baseName, downloaded };
      } catch (error) {
        const errObj = toAttachmentSaveError(att, error);
        logger(`[Email2Obsidian] Attachment ${att.id}: ${errObj.message}`);
        errors.push(errObj);
        return null;
      }
    }
  );

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
      logger(`[Email2Obsidian] Attachment ${att.id}: ${errObj.message}`);
      errors.push(errObj);
    }
  }

  return { errors, savedPathById };
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
