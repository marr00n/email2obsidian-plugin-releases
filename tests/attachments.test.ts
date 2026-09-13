import { describe, it, expect, vi } from 'vitest';
import { saveAttachments, saveBinaryData } from '../src/attachments';
import { ApiError, type AttachmentMeta } from '../src/api';
import { Vault, FileManager } from 'obsidian';
import { silentSyncReport } from '../src/sync-report';

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
      report: silentSyncReport(),
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

describe('attachments and a rate limited service', () => {
  const meta = (id: number): AttachmentMeta => ({
    id,
    fileName: `file-${id}.txt`,
    fileSize: 1,
    mimeType: 'text/plain',
    createdAt: '2026-01-01T00:00:00',
    isInline: false,
  });

  const download = (expectedName?: string) => ({
    data: toArrayBuffer('body'),
    mimeType: 'text/plain',
    fileName: expectedName ?? 'file.txt',
  });

  /** Runs the retries without the waiting, and records what was asked for. */
  function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
    const waits: number[] = [];
    return {
      waits,
      sleep: async (ms) => {
        waits.push(ms);
      },
    };
  }

  function saveOne(
    downloader: (id: number, name?: string) => Promise<ReturnType<typeof download>>,
    sleep: (ms: number) => Promise<void>,
    attachments: AttachmentMeta[] = [meta(101)]
  ) {
    return saveAttachments({
      vault: new Vault(),
      fileManager: new FileManager((name) => `Assets/${name}`),
      sourcePath: 'Notes/email.md',
      nonInlineAttachments: attachments,
      report: silentSyncReport(),
      downloader,
      sleep,
    });
  }

  it('retries after a pause and saves the file when the service relents', async () => {
    const { sleep, waits } = fakeSleep();
    const downloader = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('rate-limited', 'slow down', 429))
      .mockImplementation(async (_id: number, name?: string) => download(name));

    const result = await saveOne(downloader, sleep);

    expect(waits).toEqual([3000]);
    expect(result.errors).toEqual([]);
    expect(result.savedPathById[101]).toBe('Assets/file-101.txt');
  });

  it('throws once the retries are spent, rather than skipping the file', async () => {
    const { sleep, waits } = fakeSleep();
    const downloader = vi
      .fn()
      .mockRejectedValue(new ApiError('rate-limited', 'slow down', 429));

    // Reported as one attachment failure, the note would be written with a
    // broken link and the email marked done — a re-fetch never repairs it.
    // Thrown, it reaches runSync, which stops the run and leaves the email
    // for next time.
    await expect(saveOne(downloader, sleep)).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(waits).toEqual([3000]);
    expect(downloader).toHaveBeenCalledTimes(2);
  });

  it('still reports any other download failure per file, and writes the rest', async () => {
    const { sleep } = fakeSleep();
    const downloader = vi.fn(async (id: number, name?: string) => {
      if (id === 101) throw new Error('gone');
      return download(name);
    });

    const result = await saveOne(downloader, sleep, [meta(101), meta(102)]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('gone');
    expect(result.savedPathById[102]).toBe('Assets/file-102.txt');
  });

  it('does not start the downloads it has not begun once one is rate limited', async () => {
    const { sleep } = fakeSleep();
    const seen: number[] = [];
    const downloader = vi.fn(async (id: number) => {
      seen.push(id);
      throw new ApiError('rate-limited', 'slow down', 429);
    });

    const many = [meta(1), meta(2), meta(3), meta(4), meta(5), meta(6), meta(7), meta(8)];
    await expect(saveOne(downloader, sleep, many)).rejects.toMatchObject({
      code: 'rate-limited',
    });

    // The pool runs three at a time; whatever was in flight finishes, but the
    // rest are never asked for.
    expect(new Set(seen).size).toBeLessThan(many.length);
  });
});
