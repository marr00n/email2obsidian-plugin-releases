import { describe, it, expect, vi } from 'vitest';

import { createE2oClient, ApiError } from '../src/api';
import { createFakeHttp, jsonResponse, textResponse, binaryResponse } from './fake-http';

const API_KEY = 'test-key';

describe('createE2oClient / listEmails', () => {
  it('happy path: normalizes the emails page', async () => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: () =>
          jsonResponse(200, {
            emails: [
              {
                id: 42,
                subject: 'Weekly review',
                createdAt: '2026-09-09 08:14:02',
                hashtags: ['todo', 'work'],
                vault: 'Work',
              },
            ],
            hasMore: true,
            nextCursor: 'MjAyNi0wOS0wOSAwODoxNDowMnw0Mg',
            tags: ['todo', 'work'],
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const result = await client.listEmails();

    expect(result).toEqual({
      emails: [
        {
          id: 42,
          subject: 'Weekly review',
          createdAt: '2026-09-09T08:14:02',
          hashtags: ['todo', 'work'],
          vaultMarker: 'Work',
        },
      ],
      hasMore: true,
      nextCursor: 'MjAyNi0wOS0wOSAwODoxNDowMnw0Mg',
      tags: ['todo', 'work'],
    });
  });

  it('sends the x-api-key header', async () => {
    const routes = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: () => jsonResponse(200, { emails: [], hasMore: false }),
      },
    ]);
    const http = vi.fn(routes);
    const client = createE2oClient({ apiKey: API_KEY, http });

    await client.listEmails();

    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0].headers).toMatchObject({ 'x-api-key': API_KEY });
  });

  it('rejects a non-JSON body as bad-response', async () => {
    const http = createFakeHttp([
      { pattern: /^\/api\/emails$/, handler: () => textResponse(200, 'not json') },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const error = await client.listEmails().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('bad-response');
  });

  it('rejects a payload missing hasMore as bad-response', async () => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: () => jsonResponse(200, { emails: [] }),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const error = await client.listEmails().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('bad-response');
  });
});

describe('createE2oClient / getEmail', () => {
  function detailRoute(overrides: Record<string, unknown> = {}) {
    return {
      pattern: /^\/api\/emails\/\d+$/,
      handler: () =>
        jsonResponse(200, {
          id: 42,
          emailId: 'resend_abc123',
          subject: 'Weekly review',
          hashtags: ['todo'],
          vault: '  Work ',
          markdownBody: '# Notes',
          createdAt: '2026-09-09 08:14:02',
          expiresAt: '2026-09-12 08:14:02',
          attachments: [],
          ...overrides,
        }),
    };
  }

  it('happy path: normalizes every wire quirk', async () => {
    const http = createFakeHttp([detailRoute()]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const detail = await client.getEmail(42);

    expect(detail).toEqual({
      id: 42,
      emailId: 'resend_abc123',
      subject: 'Weekly review',
      hashtags: ['todo'],
      vaultMarker: 'Work',
      markdownBody: '# Notes',
      createdAt: '2026-09-09T08:14:02',
      expiresAt: '2026-09-12T08:14:02',
      attachments: [],
    });
  });

  it('derives isInline from contentDisposition: inline / attachment / null', async () => {
    const http = createFakeHttp([
      detailRoute({
        attachments: [
          { id: 1, fileName: 'a.png', fileSize: 1, mimeType: 'image/png', createdAt: '2026-09-09 08:14:02', contentDisposition: 'inline' },
          { id: 2, fileName: 'b.pdf', fileSize: 2, mimeType: 'application/pdf', createdAt: '2026-09-09 08:14:02', contentDisposition: 'attachment' },
          { id: 3, fileName: 'c.pdf', fileSize: 3, mimeType: 'application/pdf', createdAt: '2026-09-09 08:14:02', contentDisposition: null },
        ],
      }),
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const detail = await client.getEmail(42);

    expect(detail.attachments.map((a) => [a.id, a.isInline])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });

  it('normalizes createdAt from SQL timestamp (space) to ISO-like (T)', async () => {
    const http = createFakeHttp([detailRoute({ createdAt: '2026-09-09 08:14:02' })]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const detail = await client.getEmail(42);

    expect(detail.createdAt).toBe('2026-09-09T08:14:02');
  });

  it.each([
    ['  Work ', 'Work'],
    ['', null],
    [null, null],
  ])('normalizes vault %j to vaultMarker %j', async (wireVault, expected) => {
    const http = createFakeHttp([detailRoute({ vault: wireVault })]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const detail = await client.getEmail(42);

    expect(detail.vaultMarker).toBe(expected);
  });

  it('treats a missing vault field the same as null', async () => {
    const http = createFakeHttp([
      detailRoute({ vault: undefined }),
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const detail = await client.getEmail(42);

    expect(detail.vaultMarker).toBeNull();
  });

  it('REGRESSION: hashtags:null on the wire no longer breaks the email (old bug)', async () => {
    const http = createFakeHttp([detailRoute({ hashtags: null })]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const detail = await client.getEmail(42);

    expect(detail.hashtags).toEqual([]);
  });

  it('rejects a non-JSON body as bad-response', async () => {
    const http = createFakeHttp([
      { pattern: /^\/api\/emails\/\d+$/, handler: () => textResponse(200, '<html>nope</html>') },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const error = await client.getEmail(42).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('bad-response');
  });

  it('rejects a payload missing markdownBody as bad-response', async () => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails\/\d+$/,
        handler: () =>
          jsonResponse(200, {
            id: 42,
            subject: 'Weekly review',
            attachments: [],
            // markdownBody deliberately missing
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const error = await client.getEmail(42).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('bad-response');
  });
});

describe('createE2oClient / status mapping', () => {
  const cases: Array<[number, ApiError['code']]> = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [500, 'server-error'],
    [418, 'http-error'],
  ];

  it.each(cases)('maps HTTP %i to ApiError code %s', async (status, code) => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: () => jsonResponse(status, { status, message: 'nope' }),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const error = await client.listEmails().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    expect((error as ApiError).status).toBe(status);
  });

  it('maps a thrown adapter error to network', async () => {
    const http = vi.fn(async () => {
      throw new Error('DNS lookup failed');
    });
    const client = createE2oClient({ apiKey: API_KEY, http });

    const error = await client.listEmails().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('network');
  });
});

describe('createE2oClient / downloadAttachment', () => {
  function bytes(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer;
  }

  it('extracts a quoted filename from content-disposition', async () => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/attachments\/\d+\/download$/,
        handler: () =>
          binaryResponse(200, bytes('data'), {
            'content-disposition': 'attachment; filename="report.pdf"',
            'content-type': 'application/pdf',
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const download = await client.downloadAttachment(7);

    expect(download.fileName).toBe('report.pdf');
  });

  it('extracts an unquoted filename from content-disposition', async () => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/attachments\/\d+\/download$/,
        handler: () =>
          binaryResponse(200, bytes('data'), {
            'content-disposition': 'attachment; filename=report.pdf',
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const download = await client.downloadAttachment(7);

    expect(download.fileName).toBe('report.pdf');
  });

  it('falls back to attachment-<id> when there is no usable filename', async () => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/attachments\/\d+\/download$/,
        handler: () => binaryResponse(200, bytes('data'), {}),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const download = await client.downloadAttachment(7);

    expect(download.fileName).toBe('attachment-7');
  });

  it('prefers expectedFileName over the content-disposition filename', async () => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/attachments\/\d+\/download$/,
        handler: () =>
          binaryResponse(200, bytes('data'), {
            'content-disposition': 'attachment; filename="report.pdf"',
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const download = await client.downloadAttachment(7, 'custom-name.pdf');

    expect(download.fileName).toBe('custom-name.pdf');
  });

  it('reads mime type and content length case-insensitively', async () => {
    const http = createFakeHttp([
      {
        pattern: /^\/api\/attachments\/\d+\/download$/,
        handler: () =>
          binaryResponse(200, bytes('hello'), {
            'Content-Type': 'image/png',
            'Content-Length': '1234',
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: API_KEY, http });

    const download = await client.downloadAttachment(7);

    expect(download.mimeType).toBe('image/png');
    expect(download.contentLength).toBe(1234);
  });
});
