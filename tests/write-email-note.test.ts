import { describe, it, expect } from 'vitest';

import { App, Plugin, TFile, Vault } from 'obsidian';
import { writeEmailNote, type WriteEmailNoteContext } from '../src/write-email-note';
import { openNoteNames } from '../src/note-namer';
import { silentSyncReport } from '../src/sync-report';
import type { AttachmentMeta, EmailDetail } from '../src/api';

const NOTE_FOLDER = 'Notes';

function toArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function attachment(overrides: Partial<AttachmentMeta> & { id: number }): AttachmentMeta {
  return {
    fileName: `file-${overrides.id}.txt`,
    fileSize: 1,
    mimeType: 'text/plain',
    createdAt: '2026-01-01T00:00:00',
    isInline: false,
    ...overrides,
  };
}

function email(overrides: Partial<EmailDetail> = {}): EmailDetail {
  return {
    id: 1,
    subject: 'Hello',
    createdAt: '2026-01-01T00:00:00',
    hashtags: [],
    vaultMarker: null,
    markdownBody: 'Body',
    attachments: [],
    ...overrides,
  };
}

/**
 * A context wired the way runSync wires one: the real Note Namer over a real
 * folder, and the App's own FileManager, whose default resolver refuses to
 * resolve against a note that does not exist yet.
 */
async function makeContext(
  downloaded: Record<number, string> = {},
  downloadCalls: number[] = []
): Promise<{ ctx: WriteEmailNoteContext; vault: Vault }> {
  const vault = new Vault();
  await vault.createFolder(NOTE_FOLDER);
  const plugin = new Plugin(new App(vault));

  const ctx: WriteEmailNoteContext = {
    vault,
    fileManager: plugin.app.fileManager,
    namer: await openNoteNames(vault, NOTE_FOLDER),
    noteFolder: NOTE_FOLDER,
    downloadAttachment: async (id, expectedFileName) => {
      downloadCalls.push(id);
      const body = downloaded[id];
      if (body === undefined) {
        throw new Error(`Attachment ${id} is unavailable`);
      }
      return {
        data: toArrayBuffer(body),
        mimeType: 'text/plain',
        fileName: expectedFileName ?? `attachment-${id}`,
      };
    },
    report: silentSyncReport(),
  };

  return { ctx, vault };
}

function noteText(vault: Vault, path: string): string {
  const file = vault.getAbstractFileByPath(path);
  expect(file).toBeInstanceOf(TFile);
  return (file as TFile).text ?? '';
}

describe('writeEmailNote', () => {
  it('writes one note plus its files: attachment saved, inline image embedded', async () => {
    const { ctx, vault } = await makeContext({ 10: 'doc contents' });

    const result = await writeEmailNote(
      ctx,
      email({
        markdownBody: 'Body ![](data:text/plain;base64,QQ==)',
        attachments: [attachment({ id: 10, fileName: 'doc.txt' })],
      })
    );

    expect(result.notePath).toBe('Notes/Hello.md');
    expect(result.attachmentErrors).toEqual([]);

    expect(vault.getAbstractFileByPath('Notes/doc.txt')).toBeTruthy();
    expect(vault.getAbstractFileByPath('Notes/inline-1-0.txt')).toBeTruthy();

    const text = noteText(vault, result.notePath);
    expect(text).toContain('title: "Hello"');
    expect(text).toContain('email2obsidianID: 1');
    expect(text).toContain('![[Notes/inline-1-0.txt]]');
    expect(text).toContain('## Email Attachments');
    expect(text).toContain('- [doc.txt](Notes/doc.txt)');
  });

  it('creates the note before saving files, so attachment locations resolve (regression, d2961b6)', async () => {
    // The FileManager fake refuses to resolve an attachment path against a
    // source note that is not in the vault, exactly as Obsidian cannot resolve
    // "same folder as the current file" without that file. Save the files
    // before the empty note is written and every save below fails.
    const { ctx, vault } = await makeContext({ 10: 'doc contents' });

    const result = await writeEmailNote(
      ctx,
      email({
        markdownBody: 'Body ![](data:text/plain;base64,QQ==)',
        attachments: [attachment({ id: 10, fileName: 'doc.txt' })],
      })
    );

    expect(result.attachmentErrors).toEqual([]);
    // Both save paths — downloaded attachment and inline data URI — resolved
    // relative to the note's folder rather than failing or landing at the root.
    expect(vault.getAbstractFileByPath('Notes/doc.txt')).toBeTruthy();
    expect(vault.getAbstractFileByPath('Notes/inline-1-0.txt')).toBeTruthy();
    expect(vault.getAbstractFileByPath('doc.txt')).toBeNull();
  });

  it('stamps the Vault Marker into frontmatter when the email carries one', async () => {
    const { ctx, vault } = await makeContext();

    const result = await writeEmailNote(ctx, email({ vaultMarker: 'Work' }));

    expect(noteText(vault, result.notePath)).toContain('email2obsidianVault: "Work"');
  });

  it('stamps an empty Vault Marker for an Unmarked Email rather than omitting the key', async () => {
    const { ctx, vault } = await makeContext();

    const result = await writeEmailNote(ctx, email({ vaultMarker: null }));

    // ADR-0003: the key is present on every note so a Bases or Dataview query
    // over it never needs a null branch.
    const text = noteText(vault, result.notePath);
    expect(text).toBe(
      [
        '---',
        'title: "Hello"',
        'created: 2026-01-01T00:00:00',
        'tags: ["email2obsidian"]',
        'email2obsidianID: 1',
        'email2obsidianVault: ""',
        '---',
        '',
        'Body',
      ].join('\n')
    );
  });

  it('surfaces attachment failures instead of throwing, and still writes the note', async () => {
    // Attachment 10 downloads; 11 has no body, so its download throws.
    const { ctx, vault } = await makeContext({ 10: 'fine' });

    const result = await writeEmailNote(
      ctx,
      email({
        // A malformed data URI fails on the inline side too.
        markdownBody: 'Body ![](data:image/png;base64,****)',
        attachments: [
          attachment({ id: 10, fileName: 'ok.txt' }),
          attachment({ id: 11, fileName: 'gone.txt' }),
        ],
      })
    );

    expect(result.attachmentErrors).toHaveLength(2);
    expect(result.attachmentErrors.map((err) => err.message)).toEqual([
      'Attachment 11 is unavailable',
      'Inline data URI is not valid base64',
    ]);

    const text = noteText(vault, result.notePath);
    expect(vault.getAbstractFileByPath('Notes/ok.txt')).toBeTruthy();
    // The failed download falls back to a plain folder link, and the failed
    // inline placeholder is left in the body as it arrived.
    expect(text).toContain('- [gone.txt](Notes/gone.txt)');
    expect(text).toContain('![](data:image/png;base64,****)');
  });

  it('partitions inline from non-inline once: neither side crosses over', async () => {
    const downloadCalls: number[] = [];
    const { ctx, vault } = await makeContext({ 10: 'doc', 11: 'never' }, downloadCalls);

    const result = await writeEmailNote(
      ctx,
      email({
        markdownBody: 'Body ![](data:text/plain;base64,QQ==)',
        attachments: [
          attachment({ id: 10, fileName: 'doc.txt' }),
          attachment({ id: 11, fileName: 'inline.png', mimeType: 'image/png', isInline: true }),
        ],
      })
    );

    // The inline attachment is never downloaded and never listed...
    expect(downloadCalls).toEqual([10]);
    const text = noteText(vault, result.notePath);
    expect(text).not.toContain('inline.png');
    // ...and the non-inline one is listed, not embedded.
    expect(text).toContain('- [doc.txt](Notes/doc.txt)');
    expect(text).not.toContain('![[Notes/doc.txt]]');
  });
});

describe('writeEmailNote and files it did not write', () => {
  /**
   * The Note Namer scans the folder once, when it is opened. Creating a file
   * after that is the gap this guards: Obsidian Sync landing a note from
   * another device, another plugin, the user typing.
   */
  async function contextWithLateFile(
    path: string,
    contents: string
  ): Promise<{ ctx: WriteEmailNoteContext; vault: Vault }> {
    const made = await makeContext();
    await made.vault.create(path, contents);
    return made;
  }

  it('takes the next name rather than replacing a note it did not write', async () => {
    const { ctx, vault } = await contextWithLateFile(
      'Notes/Hello.md',
      '# My own note\n\nWork I would rather keep.'
    );

    const result = await writeEmailNote(ctx, email());

    expect(result.notePath).toBe('Notes/Hello-1.md');
    expect(noteText(vault, 'Notes/Hello.md')).toBe(
      '# My own note\n\nWork I would rather keep.'
    );
    expect(noteText(vault, 'Notes/Hello-1.md')).toContain('email2obsidianID: 1');
  });

  it('keeps stepping past several foreign files', async () => {
    const { ctx, vault } = await contextWithLateFile('Notes/Hello.md', 'Mine');
    await vault.create('Notes/Hello-1.md', 'Also mine');

    const result = await writeEmailNote(ctx, email());

    expect(result.notePath).toBe('Notes/Hello-2.md');
    expect(noteText(vault, 'Notes/Hello.md')).toBe('Mine');
    expect(noteText(vault, 'Notes/Hello-1.md')).toBe('Also mine');
  });

  it('does rewrite a note this plugin wrote, so a re-fetch does not pile up copies', async () => {
    const { ctx, vault } = await contextWithLateFile(
      'Notes/Hello.md',
      ['---', 'title: "Hello"', 'email2obsidianID: 1', '---', '', 'Older body'].join('\n')
    );

    const result = await writeEmailNote(ctx, email({ markdownBody: 'Newer body' }));

    expect(result.notePath).toBe('Notes/Hello.md');
    expect(noteText(vault, 'Notes/Hello.md')).toContain('Newer body');
  });

  it('claims an empty file, which is all an interrupted run of its own leaves', async () => {
    // Phase one writes the note empty and phase two fills it. A crash between
    // the two leaves nothing to lose, so the name stays usable.
    const { ctx, vault } = await contextWithLateFile('Notes/Hello.md', '');

    const result = await writeEmailNote(ctx, email());

    expect(result.notePath).toBe('Notes/Hello.md');
    expect(noteText(vault, 'Notes/Hello.md')).toContain('email2obsidianID: 1');
  });

  it('does not mistake a body mentioning the property for frontmatter', async () => {
    const { ctx, vault } = await contextWithLateFile(
      'Notes/Hello.md',
      'Notes on the plugin: it writes email2obsidianID: 42 into frontmatter.'
    );

    const result = await writeEmailNote(ctx, email());

    expect(result.notePath).toBe('Notes/Hello-1.md');
    expect(noteText(vault, 'Notes/Hello.md')).toContain('Notes on the plugin');
  });
});
