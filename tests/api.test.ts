import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createE2oClient, ApiError, type HttpResponse } from '../src/api';
import { createFakeHttp, jsonResponse, textResponse, binaryResponse } from './fake-http';

/**
 * Every other test here injects an http adapter, which leaves the default —
 * Obsidian's `requestUrl` — untested. Stand in for it so what the client asks
 * of it is visible.
 */
const requestUrlMock = vi.hoisted(() => vi.fn());
vi.mock('obsidian', () => ({ requestUrl: requestUrlMock }));

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

describe('createE2oClient / default Obsidian transport', () => {
  beforeEach(() => {
    requestUrlMock.mockReset();
  });

  /**
   * The real `requestUrl` rejects on a status of 400 or above unless it is
   * told not to. Reproducing that here is the whole point: a stand-in that
   * politely returns error responses is what let this defect through.
   */
  const obsidianBehaviour =
    (response: HttpResponse) =>
    (param: { throw?: boolean }): Promise<HttpResponse> =>
      response.status >= 400 && param.throw !== false
        ? Promise.reject(new Error(`Request failed, status ${response.status}`))
        : Promise.resolve(response);

  it('tells requestUrl not to throw, so an error status arrives as a response', async () => {
    requestUrlMock.mockImplementation(
      obsidianBehaviour(jsonResponse(429, { message: 'slow down' }))
    );
    const client = createE2oClient({ apiKey: API_KEY, warn: () => {} });

    const error = await client.listEmails().catch((e) => e);

    expect(requestUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ throw: false })
    );
    // Without it `requestUrl` rejects on any status of 400 or above, and every
    // 401, 429 and 5xx reaches the caller as a bare `network` failure with no
    // status — the friendly messages and the rate-limit discipline that read
    // the status could never run.
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('rate-limited');
    expect((error as ApiError).status).toBe(429);
  });

  it('still sends the url, method and api key the client was built with', async () => {
    requestUrlMock.mockImplementation(
      obsidianBehaviour(jsonResponse(200, { emails: [], hasMore: false }))
    );
    const client = createE2oClient({ apiKey: API_KEY, warn: () => {} });

    await client.listEmails({ sort: 'date-desc' });

    expect(requestUrlMock).toHaveBeenCalledWith({
      url: 'https://email2obsidian.com/api/emails?limit=100&sort=date-desc',
      method: 'GET',
      headers: { 'x-api-key': API_KEY },
      throw: false,
    });
  });
});

describe('createE2oClient / paging and retries', () => {
  const okPage = () => jsonResponse(200, { emails: [], hasMore: false });

  it('asks for the largest page the service allows', async () => {
    const urls: string[] = [];
    const http = vi.fn(async (request: { url: string }) => {
      urls.push(request.url);
      return okPage();
    });

    // Six times fewer round trips over a full fetch than the service's
    // default of 10, and six times fewer chances to be rate limited.
    await createE2oClient({ apiKey: API_KEY, http }).listEmails();

    expect(new URL(urls[0]).searchParams.get('limit')).toBe('100');
  });

  it('lets a caller ask for a different page size', async () => {
    const urls: string[] = [];
    const http = vi.fn(async (request: { url: string }) => {
      urls.push(request.url);
      return okPage();
    });

    await createE2oClient({ apiKey: API_KEY, http }).listEmails({ limit: 5 });

    expect(new URL(urls[0]).searchParams.get('limit')).toBe('5');
  });

  it.each([
    ['a rate limit', 429],
    ['a server error', 503],
  ])('retries once after %s and returns the second answer', async (_label, status) => {
    const waits: number[] = [];
    const http = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(status, { message: 'busy' }))
      .mockResolvedValueOnce(jsonResponse(200, { emails: [], hasMore: false }));

    const result = await createE2oClient({
      apiKey: API_KEY,
      http,
      warn: () => {},
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).listEmails();

    expect(http).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([1000]);
    expect(result.emails).toEqual([]);
  });

  it('waits as long as the service asks, when it asks for something short', async () => {
    const waits: number[] = [];
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { message: 'busy' }, { 'Retry-After': '2' })
      )
      .mockResolvedValueOnce(jsonResponse(200, { emails: [], hasMore: false }));

    await createE2oClient({
      apiKey: API_KEY,
      http,
      warn: () => {},
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).listEmails();

    expect(waits).toEqual([2000]);
  });

  it('does not sit out a long Retry-After; it reports the rate limit instead', async () => {
    const waits: number[] = [];
    const http = vi.fn(async () =>
      jsonResponse(429, { message: 'busy' }, { 'Retry-After': '600' })
    );

    const error = await createE2oClient({
      apiKey: API_KEY,
      http,
      warn: () => {},
      sleep: async (ms) => {
        waits.push(ms);
      },
    })
      .listEmails()
      .catch((e) => e);

    expect(waits).toEqual([]);
    expect(http).toHaveBeenCalledTimes(1);
    expect((error as ApiError).code).toBe('rate-limited');
  });

  it('retries a dropped connection once, then gives up', async () => {
    const http = vi.fn(async () => {
      throw new Error('net::ERR_CONNECTION_RESET');
    });

    const error = await createE2oClient({
      apiKey: API_KEY,
      http,
      warn: () => {},
      sleep: async () => {},
    })
      .listEmails()
      .catch((e) => e);

    expect(http).toHaveBeenCalledTimes(2);
    expect((error as ApiError).code).toBe('network');
  });

  it('does not retry a failure that would fail the same way again', async () => {
    const http = vi.fn(async () => jsonResponse(401, { message: 'nope' }));

    const error = await createE2oClient({ apiKey: API_KEY, http, warn: () => {} })
      .listEmails()
      .catch((e) => e);

    expect(http).toHaveBeenCalledTimes(1);
    expect((error as ApiError).code).toBe('unauthorized');
  });
});
