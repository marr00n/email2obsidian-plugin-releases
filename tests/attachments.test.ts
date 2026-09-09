import { describe, it, expect } from 'vitest';
import { saveAttachments, saveBinaryData } from '../src/attachments';
import { Vault, FileManager } from 'obsidian';

function toArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('attachments', () => {
  it('respects FileManager attachment location for direct saves', async () => {
    const vault = new Vault();
    const fileManager = new FileManager((name) => `Assets/${name}`);

    const result = await saveBinaryData({
      vault,
      fileManager,
      data: toArrayBuffer('hello'),
      suggestedName: 'report.pdf',
      sourcePath: 'Notes/email.md',
      mimeType: 'application/pdf',
    });

    expect(result.path).toBe('Assets/report.pdf');
    expect(vault.getAbstractFileByPath('Assets/report.pdf')).not.toBeNull();
  });

  it('respects FileManager attachment location for downloads', async () => {
    const vault = new Vault();
    const fileManager = new FileManager((name) => `Global/${name}`);

    const result = await saveAttachments({
      vault,
      fileManager,
      sourcePath: 'Notes/email.md',
      nonInlineAttachments: [
        {
          id: 101,
          fileName: 'photo.jpg',
          fileSize: 123,
          mimeType: 'image/jpeg',
          createdAt: '2026-01-01T00:00:00',
          isInline: false,
        },
      ],
      downloader: async (_id, expectedName) => ({
        data: toArrayBuffer('image'),
        mimeType: 'image/jpeg',
        fileName: expectedName ?? 'photo.jpg',
      }),
    });

    expect(result.savedPathById[101]).toBe('Global/photo.jpg');
    expect(vault.getAbstractFileByPath('Global/photo.jpg')).not.toBeNull();
  });
});
