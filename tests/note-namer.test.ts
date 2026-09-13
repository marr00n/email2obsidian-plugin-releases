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

  it('falls back to the date when the subject sanitises down to nothing', async () => {
    const { namer } = await namerOver('Notes');

    // `///` and `???` are not empty, so testing the raw subject sent these to
    // the literal name `email` instead of to the date.
    expect(namer.reserve('///', CREATED)).toBe('Notes/2021-01-01T00-00-00.md');
    expect(namer.reserve('???', CREATED)).toBe('Notes/2021-01-01T00-00-00-1.md');
  });

  it("falls back to 'email' only when the date is no use either", async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('???', '')).toBe('Notes/email.md');
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

  it('routes a scan failure through a supplied warn instead of console.warn', async () => {
    const vault = new Vault();
    vault.getAbstractFileByPath = () => {
      throw new Error('vault exploded');
    };
    const warnings: unknown[][] = [];

    const namer = await openNoteNames(vault, 'Notes', {
      warn: (msg, ...details) => warnings.push([msg, ...details]),
    });

    // The scan failure is not fatal — reserve() still works off an empty set.
    expect(namer.reserve('Hello', CREATED)).toBe('Notes/Hello.md');
    expect(warnings).toEqual([
      ['Unable to list folder Notes: vault exploded'],
    ]);
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

describe('openNoteNames and what the file system counts as the same name', () => {
  it('treats a name differing only in case as taken', async () => {
    // macOS and Windows both hold one file for `Report.md` and `report.md`.
    // Handing out the second, Obsidian refuses to create it and the email
    // fails on every run until the service deletes it 72 hours later.
    const { namer } = await namerOver('Notes', ['Report.md']);

    expect(namer.reserve('report', CREATED)).toBe('Notes/report-1.md');
  });

  it('treats the two Unicode spellings of an accent as the same name', async () => {
    // `Café` written with a precomposed é, then asked for with `e` plus a
    // combining accent. macOS stores one file for both.
    const { namer } = await namerOver('Notes', ['Caf\u00e9.md']);

    expect(namer.reserve('Cafe\u0301', CREATED)).toBe('Notes/Cafe\u0301-1.md');
  });

  it('keeps names it hands out apart under the same folding', async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('Invoice', CREATED)).toBe('Notes/Invoice.md');
    expect(namer.reserve('INVOICE', CREATED)).toBe('Notes/INVOICE-1.md');
  });

  it('caps a long subject at what the file system accepts', async () => {
    const { namer } = await namerOver('Notes');
    const longSubject = 'a'.repeat(400);

    const first = namer.reserve(longSubject, CREATED);
    const name = first.slice('Notes/'.length);
    expect(name.length).toBe(255);
    expect(name.endsWith('.md')).toBe(true);

    // And the suffix that keeps the second one distinct survives the cap.
    const second = namer.reserve(longSubject, CREATED).slice('Notes/'.length);
    expect(second.length).toBe(255);
    expect(second.endsWith('-1.md')).toBe(true);
    expect(second).not.toBe(name);
  });

  it('measures the cap in bytes, not characters', async () => {
    const { namer } = await namerOver('Notes');

    // Each of these is three UTF-8 bytes, so far fewer than 252 fit.
    const name = namer.reserve('あ'.repeat(200), CREATED).slice('Notes/'.length);

    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    // Cut on a character boundary, never mid-character.
    expect(name).not.toContain('\ufffd');
  });

  it('sidesteps the names Windows reserves', async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('NUL', CREATED)).toBe('Notes/NUL-note.md');
    expect(namer.reserve('com1', CREATED)).toBe('Notes/com1-note.md');
    // Only the exact reserved word: a subject that merely starts with one is
    // an ordinary name.
    expect(namer.reserve('Console output', CREATED)).toBe('Notes/Console output.md');
  });

  it('drops a trailing dot, which Windows also refuses', async () => {
    const { namer } = await namerOver('Notes');

    expect(namer.reserve('Meeting notes...', CREATED)).toBe('Notes/Meeting notes.md');
  });
});
