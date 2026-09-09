import { describe, it, expect } from 'vitest';

import { openNoteNames } from '../src/note-namer';
import { Vault } from 'obsidian';

const CREATED = '2021-01-01T00:00:00';

async function namerOver(folder: string, existing: string[] = []) {
  const vault = new Vault();
  if (folder.length) {
    await vault.createFolder(folder);
  }
  for (const name of existing) {
    await vault.create(folder.length ? `${folder}/${name}` : name, '');
  }
  return { vault, namer: await openNoteNames(vault, folder) };
}

describe('openNoteNames', () => {
  it('turns a subject into a note path inside the folder', async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('Hello there', CREATED)).toBe('Notes/Hello there.md');
  });

  it('reserves each name, so two emails with the same subject get distinct paths', async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('Invoice', CREATED)).toBe('Notes/Invoice.md');
    expect(namer.reserve('Invoice', CREATED)).toBe('Notes/Invoice-1.md');
    expect(namer.reserve('Invoice', CREATED)).toBe('Notes/Invoice-2.md');
  });

  it('respects notes already in the folder at open', async () => {
    const { namer } = await namerOver('Notes', ['Report.md', 'Report-1.md']);

    expect(namer.reserve('Report', CREATED)).toBe('Notes/Report-2.md');
  });

  it('ignores files added to the folder after open (the scan is a one-time snapshot)', async () => {
    const { vault, namer } = await namerOver('Notes');
    await vault.create('Notes/Later.md', '');

    expect(namer.reserve('Later', CREATED)).toBe('Notes/Later.md');
  });

  it('does not see notes in subfolders (the scan is shallow)', async () => {
    const vault = new Vault();
    await vault.createFolder('Notes');
    await vault.createFolder('Notes/Archive');
    await vault.create('Notes/Archive/Deep.md', '');

    const namer = await openNoteNames(vault, 'Notes');

    expect(namer.reserve('Deep', CREATED)).toBe('Notes/Deep.md');
  });

  it('works at the Obsidian Vault root', async () => {
    const { namer } = await namerOver('', ['Root note.md']);

    expect(namer.reserve('Root note', CREATED)).toBe('Root note-1.md');
    expect(namer.reserve('Fresh', CREATED)).toBe('Fresh.md');
  });

  it('returns an empty name set for a folder that does not exist yet', async () => {
    const vault = new Vault();
    const namer = await openNoteNames(vault, 'Missing');

    expect(namer.reserve('Anything', CREATED)).toBe('Missing/Anything.md');
  });

  it('falls back to createdAt when the subject is empty', async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('', '2021-01-01T00:00:00')).toBe('Notes/2021-01-01T00-00-00.md');
  });

  it("falls back to 'email' when subject and createdAt are both empty", async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('', '')).toBe('Notes/email.md');
  });

  it("falls back to 'email' when the subject sanitises down to nothing", async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('///', CREATED)).toBe('Notes/email.md');
  });

  describe('sanitisation', () => {
    const cases: Array<[string, string]> = [
      ['slashes and wildcards become spaces', 'a/b*c?d"e<f>g|h'],
      ['colons become hyphens', 'Re: lunch'],
      ['runs of whitespace collapse', 'too    many\tspaces'],
      ['leading and trailing whitespace is trimmed', '  padded  '],
    ];

    const expected: Record<string, string> = {
      'a/b*c?d"e<f>g|h': 'Notes/a b c d e f g h.md',
      'Re: lunch': 'Notes/Re- lunch.md',
      'too    many\tspaces': 'Notes/too many spaces.md',
      '  padded  ': 'Notes/padded.md',
    };

    for (const [label, subject] of cases) {
      it(label, async () => {
        const { namer } = await namerOver('Notes');
        expect(namer.reserve(subject, CREATED)).toBe(expected[subject]);
      });
    }
  });

  it('never hands out a path containing a directory separator from the subject', async () => {
    const { namer } = await namerOver('Notes');

    const notePath = namer.reserve('deep/nested/subject', CREATED);
    expect(notePath).toBe('Notes/deep nested subject.md');
  });

  it('reserves synchronously, so concurrent callers cannot collide', async () => {
    const { namer } = await namerOver('Notes');

    // No awaits between the two calls: this is exactly what the two sync
    // workers do, and it is why no mutex is needed around reserve().
    const paths = ['Same', 'Same', 'Same'].map((subject) =>
      namer.reserve(subject, CREATED)
    );

    expect(new Set(paths).size).toBe(3);
    expect(paths).toEqual(['Notes/Same.md', 'Notes/Same-1.md', 'Notes/Same-2.md']);
  });
});
