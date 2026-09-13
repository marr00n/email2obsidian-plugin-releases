import { FileManager, TFile, Vault } from 'obsidian';
import type { AttachmentMeta, DownloadAttachment, EmailDetail } from './api';
import {
  saveAttachments,
  saveBinaryData,
  type AttachmentSaveError,
  type Sleep,
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
  /** Passed to `saveAttachments` for its retry pause; injectable for tests. */
  sleep?: Sleep;
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
 * per file. The path it settles on never names a file this plugin did not
 * write — see `claimNotePath`.
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
 * Attachment trouble comes back in `attachmentErrors` rather than thrown —
 * one bad file does not cost the user the note. It throws when the note
 * itself cannot be written, and when the service rate limits a download: that
 * one is the run's to answer, not this note's (see `saveAttachments`). Either
 * way the empty note phase one created is taken back on the way out.
 */
export async function writeEmailNote(
  ctx: WriteEmailNoteContext,
  detail: EmailDetail
): Promise<WriteEmailNoteResult> {
  const { vault, namer } = ctx;

  // Partition once, here. `saveAttachments` takes the non-inline files;
  // `renderEmailMarkdown` lists those same files in the Attachments section.
  // Inline attachments are not saved from this list at all — they reach the
  // note as data URIs in the body and are saved by the inline saver below.
  const { inline, nonInline } = partitionByInline(detail.attachments);

  const notePath = await claimNotePath(vault, namer, detail);

  // Phase one: the empty note. See the ordering invariant above.
  await writeOrCreateNote(vault, notePath, '');

  try {
    return await fillNote(ctx, detail, notePath, { inline, nonInline });
  } catch (error) {
    // Phase two never ran, so the note is still the empty placeholder phase
    // one made. Left there it is a blank note in the user's inbox for ever,
    // and because its name is taken the next run writes the same email
    // beside it as `-1`. Take it back before the failure goes up.
    await discardEmptyNote(ctx, notePath);
    throw error;
  }
}

/**
 * Phase two: everything that happens once the empty note exists — the files,
 * the render, and the contents written into the note phase one created.
 */
async function fillNote(
  ctx: WriteEmailNoteContext,
  detail: EmailDetail,
  notePath: string,
  attachments: { inline: AttachmentMeta[]; nonInline: AttachmentMeta[] }
): Promise<WriteEmailNoteResult> {
  const { vault, fileManager, noteFolder, downloadAttachment, report, sleep } = ctx;
  const { inline, nonInline } = attachments;

  const attachmentErrors: AttachmentSaveError[] = [];

  const saveStart = Date.now();
  const savedAttachments = await saveAttachments({
    vault,
    fileManager,
    nonInlineAttachments: nonInline,
    sourcePath: notePath,
    downloader: downloadAttachment,
    report,
    sleep,
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

/**
 * Undo phase one. Only ever called on a file this run created moments ago,
 * and only while it is still empty — anything written into it since is
 * someone else's and stays. Trashed rather than deleted, so it follows the
 * user's own deletion preference.
 */
async function discardEmptyNote(
  ctx: WriteEmailNoteContext,
  notePath: string
): Promise<void> {
  const file = ctx.vault.getAbstractFileByPath(notePath);
  if (!(file instanceof TFile)) return;
  try {
    if ((await ctx.vault.read(file)).trim().length) return;
    await ctx.fileManager.trashFile(file);
  } catch (error) {
    // The original failure is the one worth reporting; this is a tidy-up.
    ctx.report.warn(
      `Could not remove the empty note at ${notePath}: ${(error as Error).message}`
    );
  }
}

/**
 * The frontmatter property every note this plugin writes carries. A file that
 * has it is one of ours and can be rewritten; a file that does not is the
 * user's, whoever put it there.
 */
const OWN_NOTE_PROPERTY = 'email2obsidianID';

/**
 * How many names to try before giving up. Only a file the plugin did not
 * write costs an attempt, so reaching this means the folder is genuinely full
 * of foreign files under this subject — worth failing loudly over.
 */
const MAX_NAME_ATTEMPTS = 100;

/**
 * Take a note path the Note Namer hands out, and keep taking the next one
 * until it names something safe to write.
 *
 * The namer scans the destination folder once, so between that scan and this
 * write a file can appear at the path it believes is free — Obsidian Sync
 * landing a note from another device, another plugin, the user. Writing there
 * replaced that file's whole contents with an email, silently and with no
 * undo. Each name is therefore checked against the vault as it is right now,
 * and anything that is not this plugin's own note is treated as a collision
 * like any other: the namer is asked again and answers `-1`, `-2`, and so on.
 *
 * Concurrent workers stay safe because `reserve` still hands out and records
 * each candidate in one tick; the awaits here only decide whether to keep the
 * name it gave or step past it, and a name stepped past stays reserved.
 */
async function claimNotePath(
  vault: Vault,
  namer: NoteNamer,
  detail: EmailDetail
): Promise<string> {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = namer.reserve(detail.subject, detail.createdAt);
    const existing = vault.getAbstractFileByPath(candidate);
    if (!(existing instanceof TFile)) return candidate;
    if (await isOwnNote(vault, existing)) return candidate;
  }
  throw new Error(
    `Could not find a free filename for email ${detail.id} after ${MAX_NAME_ATTEMPTS} tries.`
  );
}

/**
 * Is this file one the plugin may rewrite?
 *
 * Its own notes carry `email2obsidianID` in their frontmatter. An empty file
 * counts too: that is what a run interrupted between creating the note and
 * filling it leaves behind, and there is no content in it to lose.
 */
async function isOwnNote(vault: Vault, file: TFile): Promise<boolean> {
  let contents: string;
  try {
    contents = await vault.read(file);
  } catch {
    // Unreadable is not provably ours, so treat it as the user's.
    return false;
  }
  if (!contents.trim().length) return true;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(contents);
  if (!frontmatter) return false;
  return new RegExp(`^${OWN_NOTE_PROPERTY}:`, 'm').test(frontmatter[1]);
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
