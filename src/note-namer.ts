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
      let candidate = `${base}.md`;
      let suffix = 1;

      while (taken.has(candidate)) {
        candidate = `${base}-${suffix}.md`;
        suffix += 1;
      }

      taken.add(candidate);
      return joinPosix(folder, candidate);
    },
  };
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
        names.add(child.name);
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
    .trim();
  return cleaned.length ? cleaned : 'email';
}
