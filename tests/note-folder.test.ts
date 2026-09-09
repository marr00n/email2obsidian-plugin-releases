import { describe, it, expect } from 'vitest';

import { resolveNoteFolder } from '../src/note-folder';
import { Vault, TFolder } from 'obsidian';

describe('resolveNoteFolder', () => {
  it("treats '' as the Vault root: empty path, isRoot true, no folder created", async () => {
    const vault = new Vault();

    const folder = await resolveNoteFolder(vault, '');

    expect(folder.path).toBe('');
    expect(folder.isRoot).toBe(true);
    expect(vault.getRoot()).toBeInstanceOf(TFolder);
  });

  it("treats '.' as the Vault root too: same resolution as ''", async () => {
    const vault = new Vault();

    const folder = await resolveNoteFolder(vault, '.');

    expect(folder.path).toBe('');
    expect(folder.isRoot).toBe(true);
  });

  it('creates a nested folder that does not exist yet', async () => {
    const vault = new Vault();

    const folder = await resolveNoteFolder(vault, 'Notes/Inbox');

    expect(folder.path).toBe('Notes/Inbox');
    expect(folder.isRoot).toBe(false);
    expect(vault.getAbstractFileByPath('Notes/Inbox')).toBeInstanceOf(TFolder);
  });

  it('leaves an already-existing folder untouched (does not throw)', async () => {
    const vault = new Vault();
    await vault.createFolder('Notes');

    const folder = await resolveNoteFolder(vault, 'Notes');

    expect(folder.path).toBe('Notes');
    expect(vault.getAbstractFileByPath('Notes')).toBeInstanceOf(TFolder);
  });

  describe('pathFor', () => {
    it('joins a filename onto a non-root folder', async () => {
      const vault = new Vault();
      const folder = await resolveNoteFolder(vault, 'Notes');

      expect(folder.pathFor('Hello.md')).toBe('Notes/Hello.md');
    });

    it('returns the bare filename for the root folder', async () => {
      const vault = new Vault();
      const folder = await resolveNoteFolder(vault, '');

      expect(folder.pathFor('Hello.md')).toBe('Hello.md');
    });

    it('returns the bare filename for the root folder resolved from "."', async () => {
      const vault = new Vault();
      const folder = await resolveNoteFolder(vault, '.');

      expect(folder.pathFor('Hello.md')).toBe('Hello.md');
    });
  });
});
