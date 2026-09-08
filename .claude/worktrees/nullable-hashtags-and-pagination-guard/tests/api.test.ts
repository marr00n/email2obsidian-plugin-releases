import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequestUrl = vi.fn();

vi.mock('obsidian', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('obsidian');
  return { ...actual, requestUrl: (...args: any[]) => mockRequestUrl(...args) };
});

import { getEmail, ApiError } from '../src/api';

function jsonResponse(body: unknown) {
  return { status: 200, text: JSON.stringify(body), headers: {} };
}

const baseDetail = {
  id: 1,
  subject: 'Hi',
  createdAt: '2021',
  markdownBody: 'Body',
  attachments: [],
};

beforeEach(() => {
  mockRequestUrl.mockReset();
});

describe('getEmail hashtags validation', () => {
  it('accepts a null hashtags column', async () => {
    mockRequestUrl.mockResolvedValue(jsonResponse({ ...baseDetail, hashtags: null }));

    const email = await getEmail(1, 'k');

    expect(email.hashtags).toBeNull();
  });

  it('accepts a missing hashtags field', async () => {
    mockRequestUrl.mockResolvedValue(jsonResponse(baseDetail));

    await expect(getEmail(1, 'k')).resolves.toMatchObject({ id: 1 });
  });

  it('accepts a populated hashtags array', async () => {
    mockRequestUrl.mockResolvedValue(
      jsonResponse({ ...baseDetail, hashtags: ['work'] })
    );

    const email = await getEmail(1, 'k');

    expect(email.hashtags).toEqual(['work']);
  });

  it('still rejects a hashtags value that is neither array nor null', async () => {
    mockRequestUrl.mockResolvedValue(
      jsonResponse({ ...baseDetail, hashtags: 'work' })
    );

    await expect(getEmail(1, 'k')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'bad-response',
    });
  });

  it('still rejects a genuinely malformed response', async () => {
    mockRequestUrl.mockResolvedValue(jsonResponse({ id: 'nope' }));

    await expect(getEmail(1, 'k')).rejects.toBeInstanceOf(ApiError);
  });
});
