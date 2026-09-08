import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runSync } from '../src/pipeline';
import { Vault, Plugin, App } from 'obsidian';

const mockListEmails = vi.fn();
const mockGetEmail = vi.fn();
const mockDownload = vi.fn();

vi.mock('../src/api', () => ({
  listEmails: (...args: any[]) => mockListEmails(...args),
  getEmail: (...args: any[]) => mockGetEmail(...args),
  downloadAttachment: (...args: any[]) => mockDownload(...args),
}));

function summary(id: number) {
  return { id, subject: `Email ${id}`, createdAt: '2021', hashtags: null };
}

function detail(id: number) {
  return { ...summary(id), markdownBody: 'Body', attachments: [] };
}

function sync(notifier: (msg: string) => void = () => {}) {
  const vault = new Vault();
  return runSync(
    {
      mode: 'fetch-new',
      settings: { apiKey: 'k', notesFolder: 'Notes' },
      vault,
      plugin: new Plugin(new App(vault)),
    },
    notifier
  );
}

beforeEach(() => {
  mockListEmails.mockReset();
  mockGetEmail.mockReset();
  mockDownload.mockReset();
  mockGetEmail.mockImplementation((id: number) => Promise.resolve(detail(id)));
});

describe('paginateEmails cursor handling', () => {
  it('stops instead of refetching page 0 when hasMore has no cursor', async () => {
    // Guards against an infinite loop: without the cursor check this mock is
    // called until the cap trips, because an undefined cursor restarts paging.
    let calls = 0;
    mockListEmails.mockImplementation(() => {
      calls += 1;
      if (calls > 50) throw new Error('paginateEmails looped on page 0');
      return Promise.resolve({ emails: [summary(1)], hasMore: true, nextCursor: null });
    });

    const result = await sync();

    expect(calls).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.synced).toBe(1);
  });

  it('warns the user when a sync is cut short', async () => {
    let calls = 0;
    mockListEmails.mockImplementation(() => {
      calls += 1;
      if (calls > 50) throw new Error('paginateEmails looped on page 0');
      return Promise.resolve({ emails: [summary(1)], hasMore: true, nextCursor: null });
    });
    const messages: string[] = [];

    await sync((msg) => messages.push(msg));

    expect(messages.some((m) => m.includes('some emails may be missing'))).toBe(true);
  });

  it('walks every page when the server paginates properly', async () => {
    mockListEmails
      .mockResolvedValueOnce({ emails: [summary(1)], hasMore: true, nextCursor: 'c1' })
      .mockResolvedValueOnce({ emails: [summary(2)], hasMore: false, nextCursor: null });

    const result = await sync();

    expect(mockListEmails).toHaveBeenCalledTimes(2);
    expect(mockListEmails.mock.calls[1][0]).toMatchObject({ cursor: 'c1' });
    expect(result.truncated).toBe(false);
    expect(result.synced).toBe(2);
  });

  it('does not flag a clean single-page sync as truncated', async () => {
    mockListEmails.mockResolvedValue({
      emails: [summary(1)],
      hasMore: false,
      nextCursor: null,
    });

    const result = await sync();

    expect(mockListEmails).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(false);
  });
});
