import { FileManager, TFile, Vault } from 'obsidian';
import type { AttachmentMeta, DownloadAttachment, EmailDetail } from './api';
import {
  saveAttachments,
  saveBinaryData,
  type AttachmentSaveError,
} from './attachments';
import { renderEmailMarkdown } from './helpers';
import type { NoteNamer } from './note-namer';
import type { SyncReport } from './sync-report';

/** What one email-to-note job needs from its caller. */
export interface WriteEmailNoteContext {
  vault: Vault;
  fileManager: FileManager;
  /** Hands out the note path; already opened over `noteFolder`. */
  namer: NoteNamer;
  /** Destination folder for notes; `''` means the Obsidian Vault root. */
  noteFolder: string;
  /** The Service Client's `downloadAttachment`; credentials live in the client. */
  downloadAttachment: DownloadAttachment;
  /**
   * Where this job's diagnostics and per-file warnings go — passed straight
   * through to `saveAttachments`. Use `silentSyncReport()` to say nothing.
   */
  report: SyncReport;
}

export interface WriteEmailNoteResult {
  /** The path the note was written to, as reserved by the Note Namer. */
  notePath: string;
  /**
   * Per-file failures — a download that failed, a data URI that would not
   * decode. These are reported, never thrown: one bad attachment does not
   * cost the user the note.
   */
  attachmentErrors: AttachmentSaveError[];
}

/**
 * One email becomes one note plus its files.
 *
 * Reserves a note path, writes the note, saves the email's attachments and
 * inline images beside it, and hands back the path plus whatever went wrong
 * per file.
 *
 * ## The note is created empty before any file is saved
 *
 * This ordering is load-bearing, not incidental. Attachment paths come from
 * Obsidian's `fileManager.getAvailablePathForAttachment(name, sourcePath)`,
 * which resolves the user's attachment-location setting — "same folder as the
 * current file", "in a subfolder under the current folder" — against the
 * actual vault state at the moment it is called. If the note at `sourcePath`
 * does not exist yet, Obsidian cannot resolve those relative settings and
 * files land in the wrong folder. That was a shipped bug (commit d2961b6).
 *
 * So the job is two-phase: create the note empty, save every file against it,
 * then write the rendered markdown into the note that is already there. The
 * rendered markdown embeds the paths the saves came back with, so the render
 * cannot come first either.
 *
 * Callers do not need to know any of this — nor that rendering the body itself
 * writes files (inline data URIs), nor that those writes need a `sourcePath`.
 *
 * Throws only if the note itself cannot be written; attachment trouble comes
 * back in `attachmentErrors`.
 */
export async function writeEmailNote(
  ctx: WriteEmailNoteContext,
  detail: EmailDetail
): Promise<WriteEmailNoteResult> {
  const { vault, fileManager, namer, noteFolder, downloadAttachment, report } = ctx;

  // Partition once, here. `saveAttachments` takes the non-inline files;
  // `renderEmailMarkdown` lists those same files in the Attachments section.
  // Inline attachments are not saved from this list at all — they reach the
  // note as data URIs in the body and are saved by the inline saver below.
  const { inline, nonInline } = partitionByInline(detail.attachments);

  const notePath = namer.reserve(detail.subject, detail.createdAt);

  // Phase one: the empty note. See the ordering invariant above.
  await writeOrCreateNote(vault, notePath, '');

  const attachmentErrors: AttachmentSaveError[] = [];

  const saveStart = Date.now();
  const savedAttachments = await saveAttachments({
    vault,
    fileManager,
    nonInlineAttachments: nonInline,
    sourcePath: notePath,
    downloader: downloadAttachment,
    report,
  });
  report.debug(
    `saveAttachments for email ${detail.id} completed in ${Date.now() - saveStart}ms; saved ${
      Object.keys(savedAttachments.savedPathById).length
    } of ${nonInline.length} non-inline attachments (${inline.length} inline)`
  );
  attachmentErrors.push(...savedAttachments.errors);

  const renderStart = Date.now();
  const renderResult = await renderEmailMarkdown(
    detail,
    { noteFolder },
    {
      nonInlineAttachments: nonInline,
      savedPaths: savedAttachments.savedPathById,
      inlineSaver: (opts) =>
        saveBinaryData({
          vault,
          fileManager,
          data: opts.data,
          suggestedName: opts.suggestedName,
          sourcePath: notePath,
          mimeType: opts.mimeType,
        }),
    }
  );
  report.debug(
    `renderEmailMarkdown for email ${detail.id} in ${Date.now() - renderStart}ms (inline embeds: ${
      Object.keys(renderResult.inlineEmbeds).length
    }, inline errors: ${renderResult.inlineErrors.length})`
  );
  attachmentErrors.push(...renderResult.inlineErrors);

  // Phase two: the same note, now with its contents.
  const writeStart = Date.now();
  await writeOrCreateNote(vault, notePath, renderResult.markdown);
  report.debug(`writeOrCreateNote ${notePath || '(root)'} in ${Date.now() - writeStart}ms`);

  return { notePath, attachmentErrors };
}

function partitionByInline(attachments: AttachmentMeta[] | undefined): {
  inline: AttachmentMeta[];
  nonInline: AttachmentMeta[];
} {
  const inline: AttachmentMeta[] = [];
  const nonInline: AttachmentMeta[] = [];
  for (const att of attachments || []) {
    if (att.isInline) {
      inline.push(att);
    } else {
      nonInline.push(att);
    }
  }
  return { inline, nonInline };
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
