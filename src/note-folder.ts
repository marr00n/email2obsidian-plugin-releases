import { normalizePath, Vault } from 'obsidian';
import { isRootPath, joinPosix } from './path-utils';

/**
 * The notes destination folder, resolved once. Wraps the policy that used to
 * be re-decided at every call site: `''` and `'.'` both mean the Obsidian
 * Vault root, and a non-root folder is created (if missing) at resolution
 * time rather than defensively re-checked by each consumer.
 */
export interface NoteFolder {
  /** `''` for the Vault root; otherwise the normalized folder path. */
  readonly path: string;
  readonly isRoot: boolean;
  /** Joins `filename` onto this folder — correct for both root and non-root. */
  pathFor(filename: string): string;
}

/**
 * Normalize `folderSetting` ('' and '.' both mean the Vault root), create the
 * folder if it doesn't already exist and isn't root, and hand back a
 * `NoteFolder` carrying that resolution so nothing downstream has to repeat
 * it.
 */
export async function resolveNoteFolder(
  vault: Vault,
  folderSetting: string
): Promise<NoteFolder> {
  const root = isRootPath(folderSetting);
  const path = root ? '' : normalizePath(folderSetting);

  if (!root) {
    await ensureFolder(vault, path);
  }

  return {
    path,
    isRoot: root,
    pathFor(filename: string): string {
      return joinPosix(path, filename);
    },
  };
}

/**
 * Create `folder` if it doesn't already exist. A no-op for root ('' or '.').
 * Used by `resolveNoteFolder` above for the notes folder, and by
 * `write-email-note.ts` for a per-email attachment folder — attachment saves
 * that go through `fileManager.getAvailablePathForAttachment` create missing
 * folders themselves and never need this.
 */
export async function ensureFolder(vault: Vault, folder: string): Promise<void> {
  if (!folder || isRootPath(folder)) {
    return;
  }
  const normalized = normalizePath(folder);
  try {
    await vault.createFolder(normalized);
  } catch (error) {
    // createFolder throws if it already exists; ignore that case.
    if (!(error instanceof Error && /exist/i.test(error.message))) {
      throw error;
    }
  }
}
