import { normalizePath, Vault, TFile } from 'obsidian';
import { AttachmentMeta, AttachmentDownload, downloadAttachment } from './api';
import { basename, extname, joinPosix, isRootPath } from './path-utils';

export interface SaveAttachmentsOptions {
  vault: Vault;
  apiKey: string;
  noteFolder: string;
  attachmentFolder?: string | null;
  attachments: AttachmentMeta[];
  logger?: (msg: string) => void;
  downloader?: typeof downloadAttachment;
}

export interface SaveAttachmentsResult {
  errors: AttachmentSaveError[];
  savedNameById: Record<number, string>;
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

export interface AttachmentTarget {
  noteFolderPath: string;
  attachmentTargetPath: string;
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

export async function resolveAttachmentTarget(opts: {
  vault: Vault;
  noteFolder: string;
  attachmentFolder?: string | null;
}): Promise<AttachmentTarget> {
  const { vault, noteFolder, attachmentFolder } = opts;

  const noteFolderIsRoot = isRootPath(noteFolder);
  const noteFolderPath = noteFolderIsRoot ? '' : normalizePath(noteFolder);

  const hasAttachmentFolder =
    typeof attachmentFolder === 'string' && !isRootPath(attachmentFolder);
  const resolvedAttachment = hasAttachmentFolder && attachmentFolder
    ? normalizePath(attachmentFolder)
    : noteFolderPath;

  if (!noteFolderIsRoot) {
    await ensureFolder(vault, noteFolderPath);
  }
  if (resolvedAttachment && resolvedAttachment !== noteFolderPath) {
    await ensureFolder(vault, resolvedAttachment);
  }

  return {
    noteFolderPath,
    attachmentTargetPath: resolvedAttachment,
  };
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
  data: ArrayBuffer;
  suggestedName: string;
  targetFolder: string;
  mimeType?: string | null;
}): Promise<{ filename: string; path: string }> {
  const { vault, data, suggestedName, targetFolder, mimeType } = opts;

  const sanitized = sanitizeAttachmentName(suggestedName);
  const providedExt = extname(sanitized);
  const extension = providedExt || getExtensionForMime(mimeType);
  const base = basename(sanitized, providedExt);

  const filename = await uniqueFilename(vault, targetFolder, `${base}${extension}`);
  const path = joinPosix(targetFolder, filename);
  await writeBinaryFile(vault, path, data);

  return { filename, path };
}

/**
 * Download and save non-inline attachments to the vault, collision-proofing filenames.
 * Targets the attachment folder when provided, otherwise the note folder.
 */
export async function saveAttachments(
  opts: SaveAttachmentsOptions
): Promise<SaveAttachmentsResult> {
  const {
    vault,
    apiKey,
    attachments,
    noteFolder,
    attachmentFolder,
    logger = console.warn,
    downloader = downloadAttachment,
  } = opts;

  const { attachmentTargetPath } = await resolveAttachmentTarget({
    vault,
    noteFolder,
    attachmentFolder,
  });

  const nonInline = attachments.filter(
    (att) => att.contentDisposition !== 'inline'
  );

  const errors: AttachmentSaveError[] = [];
  const savedNameById: Record<number, string> = {};

  const downloads = await runWithConcurrency(
    nonInline,
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
        const downloaded = await downloader(att.id, apiKey, baseName);
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
        targetFolder: attachmentTargetPath,
        mimeType: downloaded.mimeType,
      });
      savedNameById[att.id] = saved.filename;
    } catch (error) {
      const errObj = toAttachmentSaveError(att, error);
      logger(`[Email2Obsidian] Attachment ${att.id}: ${errObj.message}`);
      errors.push(errObj);
    }
  }

  return { errors, savedNameById };
}

export async function ensureFolder(vault: Vault, folder: string): Promise<void> {
  if (!folder || isRootPath(folder)) {
    return;
  }
  const normalized = normalizePath(folder);
  try {
    await vault.createFolder(normalized);
  } catch (error) {
    // createFolder throws if exists; ignore that case.
    if (!(error instanceof Error && /exist/i.test(error.message))) {
      throw error;
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

async function uniqueFilename(
  vault: Vault,
  folder: string,
  filename: string
): Promise<string> {
  const ext = extname(filename);
  const base = basename(filename, ext);

  let candidate = filename;
  let suffix = 1;
  while (fileExists(vault, joinPosix(folder, candidate))) {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
  }

  return candidate;
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

function fileExists(vault: Vault, filePath: string): boolean {
  const abstract = vault.getAbstractFileByPath(filePath);
  return Boolean(abstract);
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let current = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = current;
      if (index >= items.length) {
        break;
      }
      current += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
