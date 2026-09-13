import { TFile, TFolder, Vault } from 'obsidian';
import { joinPosix } from './path-utils';
import { prefixedWarn } from './sync-report';

/**
 * Owns the question "which filename does an email-derived note get?".
 *
 * A namer is opened against one destination folder, scans it once, and from
 * then on hands out note paths that are unique both against what was already
 * in the folder and against everything it has handed out since.
 */
export interface NoteNamer {
  /**
   * Claim a note path for one email: sanitise the subject (falling back to
   * createdAt, then to `email`), append `-1`, `-2`, … until nothing collides,
   * and record the result so no later call can hand out the same path.
   *
   * Synchronous on purpose — concurrent sync workers can call it without any
   * locking, because the check and the reservation happen in one tick.
   */
  reserve(subject: string, createdAt: string): string;
}

/**
 * The longest filename the file systems Obsidian runs on accept, in UTF-8
 * bytes. A long email subject sails past it and the create is refused, which
 * before this cap meant the email failed on every run until the service
 * deleted it 72 hours later.
 */
const MAX_FILENAME_BYTES = 255;

/**
 * Names Windows refuses whatever the extension. A subject of exactly `NUL`
 * is unlikely; costing an email its only three days of life is not worth the
 * odds.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface OpenNoteNamesOptions {
  /**
   * Where a scan failure is reported. Defaults to the same prefixed
   * `console.warn` this has always used, so callers that don't pass one see
   * no change; `runSync` passes `report.warn` so the failure narrates
   * through the sync's one seam instead.
   */
  warn?: (msg: string, ...details: unknown[]) => void;
}

/**
 * Open a NoteNamer over `folder` (empty string means the Obsidian Vault root),
 * taking the one-time snapshot of the note names already in it.
 */
export async function openNoteNames(
  vault: Vault,
  folder: string,
  options: OpenNoteNamesOptions = {}
): Promise<NoteNamer> {
  const warn = options.warn ?? prefixedWarn;
  const taken = scanFileNames(vault, folder, warn);

  return {
    reserve(subject: string, createdAt: string): string {
      const base = sanitizeFilename(subject || createdAt || 'email');
      let candidate = withinByteLimit(base, 0);
      let suffix = 1;

      while (taken.has(nameKey(candidate))) {
        candidate = withinByteLimit(base, suffix);
        suffix += 1;
      }

      taken.add(nameKey(candidate));
      return joinPosix(folder, candidate);
    },
  };
}

/**
 * How one filename is compared against another.
 *
 * Exact text is the wrong test. macOS and Windows both treat `Report.md` and
 * `report.md` as one file, and macOS also treats the two Unicode spellings of
 * an accented letter — `é` as one code point, or `e` plus a combining accent —
 * as the same name. Comparing exactly, the namer called such a name free,
 * Obsidian refused to create the file (it refuses; it does not overwrite),
 * and the email failed on every run until the service deleted it. Folding
 * case and normalising the accents makes the namer see what the file system
 * sees, so it moves on to `-1` as it would for any other collision.
 */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * `base-<suffix>.md`, with the base trimmed until the whole name fits the
 * byte limit. Trimmed by code point rather than by byte so a character is
 * never cut in half, and the suffix is measured too — it is what has to
 * survive, since it is what makes the name unique.
 */
function withinByteLimit(base: string, suffix: number): string {
  const tail = suffix === 0 ? '.md' : `-${suffix}.md`;
  const budget = MAX_FILENAME_BYTES - byteLength(tail);

  let trimmed = '';
  let used = 0;
  for (const char of base) {
    const size = byteLength(char);
    if (used + size > budget) break;
    trimmed += char;
    used += size;
  }

  // Trimming can leave a trailing space or dot, which Windows refuses.
  trimmed = trimmed.replace(/[\s.]+$/, '');
  return `${trimmed.length ? trimmed : 'email'}${tail}`;
}

function byteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Shallow, non-recursive: we intentionally skip subfolders to keep scans cheap
 * on large Obsidian Vaults. Notes only ever land directly in `folder`, so a
 * deeper scan would cost more without changing a single name.
 */
function scanFileNames(
  vault: Vault,
  folder: string,
  warn: (msg: string, ...details: unknown[]) => void
): Set<string> {
  const names = new Set<string>();
  try {
    const target = folder.length ? vault.getAbstractFileByPath(folder) : vault.getRoot();
    if (!(target instanceof TFolder)) {
      return names;
    }
    for (const child of target.children) {
      if (child instanceof TFile) {
        names.add(nameKey(child.name));
      }
    }
  } catch (error: unknown) {
    // A missing folder is not fatal: it gets created before any note is written.
    warn(
      `Unable to list folder ${
        folder.length ? folder : 'vault root'
      }: ${(error as Error).message}`
    );
  }
  return names;
}

function sanitizeFilename(input: string): string {
  const cleaned = input
    .replace(/[\\/*?"<>|]+/g, ' ')
    .replace(/:/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows refuses a name ending in a dot; the trim above took the spaces.
    .replace(/\.+$/, '')
    .trim();
  if (!cleaned.length) return 'email';
  return WINDOWS_RESERVED.test(cleaned) ? `${cleaned}-note` : cleaned;
}
