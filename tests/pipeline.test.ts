import { describe, it, expect, vi } from 'vitest';

import { runSync, type PipelineSettings } from '../src/pipeline';
import { createE2oClient } from '../src/api';
import { createSyncReport } from '../src/sync-report';
import { Vault, Plugin, App, TFile } from 'obsidian';
import { createFakeHttp, jsonResponse, binaryResponse, type FakeRoute } from './fake-http';

function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function noteText(vault: Vault, path: string): string {
  const file = vault.getAbstractFileByPath(path);
  expect(file).toBeInstanceOf(TFile);
  return (file as TFile).text ?? '';
}

function noteExists(vault: Vault, path: string): boolean {
  return vault.getAbstractFileByPath(path) !== null;
}

/* -------------------------------------------------------------------------
 * A pretend server for the multi-vault cases: pages of email, each carrying
 * the wire `vault` field, with every detail and attachment request recorded.
 * Declining an email is meant to cost nothing, and the only way to show that
 * is to watch what the run asked the service for.
 * ---------------------------------------------------------------------- */

interface WireEmail {
  id: number;
  subject: string;
  /** The wire field, as the service sends it: a Vault Marker or null. */
  vault?: string | null;
  attachment?: boolean;
}

interface FakeServer {
  http: ReturnType<typeof createFakeHttp>;
  /** The `cursor` parameter of each list request, in order. */
  listCursors: (string | null)[];
  /** Every email whose detail was fetched. */
  detailCalls: number[];
  /** Every attachment downloaded. */
  attachmentCalls: number[];
}

function fakeServer(pages: WireEmail[][]): FakeServer {
  const all = pages.flat();
  const listCursors: (string | null)[] = [];
  const detailCalls: number[] = [];
  const attachmentCalls: number[] = [];

  const attachmentsOf = (email: WireEmail) =>
    email.attachment
      ? [
          {
            id: email.id * 100,
            fileName: `doc-${email.id}.txt`,
            fileSize: 1,
            mimeType: 'text/plain',
            createdAt: '2021-01-01 00:00:00',
            contentDisposition: 'attachment',
          },
        ]
      : [];

  const routes: FakeRoute[] = [
    {
      pattern: /^\/api\/emails$/,
      handler: (_request, url) => {
        const cursor = url.searchParams.get('cursor');
        listCursors.push(cursor);
        const index = cursor ? Number(cursor) : 0;
        const page = pages[index] ?? [];
        const hasMore = index + 1 < pages.length;
        return jsonResponse(200, {
          emails: page.map((email) => ({
            id: email.id,
            subject: email.subject,
            createdAt: '2021-01-01 00:00:00',
            hashtags: [],
            vault: email.vault ?? null,
          })),
          hasMore,
          nextCursor: hasMore ? String(index + 1) : null,
        });
      },
    },
    {
      pattern: /^\/api\/emails\/\d+$/,
      handler: (_request, url) => {
        const id = Number(url.pathname.split('/').pop());
        detailCalls.push(id);
        const email = all.find((candidate) => candidate.id === id);
        if (!email) return jsonResponse(404, { status: 404, message: 'Not found' });
        return jsonResponse(200, {
          id: email.id,
          subject: email.subject,
          createdAt: '2021-01-01 00:00:00',
          hashtags: [],
          vault: email.vault ?? null,
          markdownBody: `Body of ${email.subject}.`,
          attachments: attachmentsOf(email),
        });
      },
    },
    {
      pattern: /^\/api\/attachments\/\d+\/download$/,
      handler: (_request, url) => {
        attachmentCalls.push(Number(url.pathname.split('/')[3]));
        return binaryResponse(200, bytes([1]), { 'content-type': 'text/plain' });
      },
    },
  ];

  return { http: createFakeHttp(routes), listCursors, detailCalls, attachmentCalls };
}

function settings(overrides: Partial<PipelineSettings> = {}): PipelineSettings {
  return { apiKey: 'k', notesFolder: 'Notes', ...overrides };
}

/** The mixed stream every receive-policy case below is read against. */
function mixedStream(): WireEmail[] {
  return [
    { id: 4, subject: 'For work', vault: 'Work' },
    { id: 3, subject: 'For art', vault: 'Art' },
    { id: 2, subject: 'For second brain', vault: 'Second Brain' },
    { id: 1, subject: 'Unmarked one', vault: null },
  ];
}

describe('pipeline runSync', () => {
  it('combines attachment and inline saving with resolved paths, writing a frontmatter note and the fetch log', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));

    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: () =>
          jsonResponse(200, {
            emails: [
              { id: 1, subject: 'Hi', createdAt: '2021-01-01 00:00:00', hashtags: [], vault: null },
            ],
            hasMore: false,
          }),
      },
      {
        pattern: /^\/api\/emails\/1$/,
        handler: () =>
          jsonResponse(200, {
            id: 1,
            subject: 'Hi',
            createdAt: '2021-01-01 00:00:00',
            hashtags: [],
            vault: null,
            markdownBody: 'Body ![](data:text/plain;base64,QQ==)',
            attachments: [
              {
                id: 10,
                fileName: 'doc.txt',
                fileSize: 1,
                mimeType: 'text/plain',
                createdAt: '2021-01-01 00:00:00',
                contentDisposition: 'attachment',
              },
              {
                id: 11,
                fileName: 'inline.png',
                fileSize: 1,
                mimeType: 'image/png',
                createdAt: '2021-01-01 00:00:00',
                contentDisposition: 'inline',
              },
            ],
          }),
      },
      {
        pattern: /^\/api\/attachments\/10\/download$/,
        handler: () =>
          binaryResponse(200, bytes([1]), { 'content-type': 'text/plain' }),
      },
    ]);
    const client = createE2oClient({ apiKey: 'k', http });

    const result = await runSync({
      mode: 'fetch-new',
      settings: { apiKey: 'k', notesFolder: 'Notes' },
      vault,
      plugin,
      client,
    });

    expect(result.attachmentErrors).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(1);

    // attachments saved
    expect(vault.getAbstractFileByPath('Notes/doc.txt')).toBeTruthy();
    expect(vault.getAbstractFileByPath('Notes/inline-1-0.txt')).toBeTruthy();

    // note created with frontmatter
    const notePath = 'Notes/Hi.md';
    const text = noteText(vault, notePath);
    expect(text).toContain('title: "Hi"');
    expect(text).toContain('email2obsidianID: 1');
    expect(text).toContain('[doc.txt](Notes/doc.txt)');

    // fetch log written
    const stored = (await plugin.loadData()) as { 'fetch-log'?: Record<string, unknown> };
    expect(stored['fetch-log']).toHaveProperty('1');
  });

  it('syncs an email whose wire hashtags are null (regression) with only the email2obsidian tag', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));

    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: () =>
          jsonResponse(200, {
            emails: [
              { id: 2, subject: 'No tags', createdAt: '2021-01-01 00:00:00', hashtags: null, vault: null },
            ],
            hasMore: false,
          }),
      },
      {
        pattern: /^\/api\/emails\/2$/,
        handler: () =>
          jsonResponse(200, {
            id: 2,
            subject: 'No tags',
            createdAt: '2021-01-01 00:00:00',
            hashtags: null,
            vault: null,
            markdownBody: 'Plain body, no attachments.',
            attachments: [],
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: 'k', http });

    const result = await runSync({
      mode: 'fetch-new',
      settings: { apiKey: 'k', notesFolder: 'Notes' },
      vault,
      plugin,
      client,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.synced).toBe(1);

    const text = noteText(vault, 'Notes/No tags.md');
    expect(text).toContain('tags: [email2obsidian]');
  });

  it('never fetches page 2 when page 1 already holds a logged id', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    // Email 1 is already in the ledger, so the newest-first scan should stop
    // on the page that contains it: everything older is known.
    await plugin.saveData({
      'fetch-log': { '1': { fetchedAt: '2021-01-01T00:00:00.000Z', filename: 'Old.md' } },
    });

    const listCalls: (string | null)[] = [];

    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: (_request, url) => {
          listCalls.push(url.searchParams.get('cursor'));
          return jsonResponse(200, {
            emails: [
              { id: 3, subject: 'Newest', createdAt: '2021-01-03 00:00:00', hashtags: [], vault: null },
              { id: 1, subject: 'Known', createdAt: '2021-01-01 00:00:00', hashtags: [], vault: null },
            ],
            hasMore: true,
            nextCursor: 'page-2',
          });
        },
      },
      {
        pattern: /^\/api\/emails\/3$/,
        handler: () =>
          jsonResponse(200, {
            id: 3,
            subject: 'Newest',
            createdAt: '2021-01-03 00:00:00',
            hashtags: [],
            vault: null,
            markdownBody: 'Body three, no attachments.',
            attachments: [],
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: 'k', http });

    const result = await runSync({
      mode: 'fetch-new',
      settings: { apiKey: 'k', notesFolder: 'Notes' },
      vault,
      plugin,
      client,
    });

    expect(listCalls).toEqual([null]);
    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(1);

    const stored = (await plugin.loadData()) as { 'fetch-log'?: Record<string, unknown> };
    expect(Object.keys(stored['fetch-log'] ?? {}).sort()).toEqual(['1', '3']);
  });

  it('stops on a 429 from getEmail and takes the rate-limited path with a partial log write', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));

    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: () =>
          jsonResponse(200, {
            emails: [
              { id: 1, subject: 'First', createdAt: '2021-01-01 00:00:00', hashtags: [], vault: null },
              { id: 2, subject: 'Second', createdAt: '2021-01-02 00:00:00', hashtags: [], vault: null },
            ],
            hasMore: false,
          }),
      },
      {
        pattern: /^\/api\/emails\/1$/,
        handler: () =>
          jsonResponse(200, {
            id: 1,
            subject: 'First',
            createdAt: '2021-01-01 00:00:00',
            hashtags: [],
            vault: null,
            markdownBody: 'Body one, no attachments.',
            attachments: [],
          }),
      },
      {
        pattern: /^\/api\/emails\/2$/,
        handler: () => jsonResponse(429, { status: 429, message: 'Rate limited' }),
      },
    ]);
    const client = createE2oClient({ apiKey: 'k', http });

    const notices: string[] = [];

    const result = await runSync({
      mode: 'fetch-new',
      settings: { apiKey: 'k', notesFolder: 'Notes' },
      vault,
      plugin,
      client,
      report: createSyncReport({
        showNotice: (msg) => notices.push(msg),
        debugEnabled: false,
      }),
    });

    expect(result.synced).toBe(1);
    // The rate-limited path is what the user is told about: the run's only
    // notice is the rate-limit warning, not the usual sync summary.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/rate limit/i);

    // partial log write: the email that made it through before the limit hit
    // is logged, the one that hit the limit is not.
    const stored = (await plugin.loadData()) as { 'fetch-log'?: Record<string, unknown> };
    expect(stored['fetch-log']).toHaveProperty('1');
    expect(stored['fetch-log']).not.toHaveProperty('2');
  });

  it('stops the scan instead of looping forever when hasMore is true but no cursor is sent', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));

    let listCalls = 0;

    const http = createFakeHttp([
      {
        pattern: /^\/api\/emails$/,
        handler: () => {
          listCalls += 1;
          return jsonResponse(200, {
            emails: [
              { id: 1, subject: 'Only page', createdAt: '2021-01-01 00:00:00', hashtags: [], vault: null },
            ],
            // A server bug: more claimed to exist, but no cursor to fetch it with.
            hasMore: true,
            nextCursor: null,
          });
        },
      },
      {
        pattern: /^\/api\/emails\/1$/,
        handler: () =>
          jsonResponse(200, {
            id: 1,
            subject: 'Only page',
            createdAt: '2021-01-01 00:00:00',
            hashtags: [],
            vault: null,
            markdownBody: 'Body, no attachments.',
            attachments: [],
          }),
      },
    ]);
    const client = createE2oClient({ apiKey: 'k', http });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // fetch-all: paginateEmails runs with no stopWhen, so this exercises the
    // pagination loop itself rather than the ledger's early-stop.
    const result = await runSync({
      mode: 'fetch-all',
      settings: { apiKey: 'k', notesFolder: 'Notes' },
      vault,
      plugin,
      client,
      report: createSyncReport({ showNotice: () => {}, debugEnabled: false }),
    });

    // Completes rather than hanging, having fetched only the one page.
    expect(listCalls).toBe(1);
    expect(result.synced).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('reported more emails but sent no cursor')
    );

    warnSpy.mockRestore();
  });
});

describe('pipeline runSync receive policy', () => {
  it('writes only the notes this vault claims out of a mixed stream', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const server = fakeServer([mixedStream()]);

    const result = await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work', 'Second Brain'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: server.http }),
    });

    expect(result.synced).toBe(2);
    expect(result.declined).toBe(2);
    expect(noteExists(vault, 'Notes/For work.md')).toBe(true);
    expect(noteExists(vault, 'Notes/For second brain.md')).toBe(true);
    expect(noteExists(vault, 'Notes/For art.md')).toBe(false);
    expect(noteExists(vault, 'Notes/Unmarked one.md')).toBe(false);
  });

  it('takes the whole stream when no markers are configured, which is the shipped default', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const server = fakeServer([mixedStream()]);

    // No vaultMarkers and no receiveUnmarked at all: exactly the settings an
    // install that has never heard of this feature loads with.
    const result = await runSync({
      mode: 'fetch-new',
      settings: settings(),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: server.http }),
    });

    expect(result.synced).toBe(4);
    expect(result.declined).toBe(0);
    for (const email of mixedStream()) {
      expect(noteExists(vault, `Notes/${email.subject}.md`)).toBe(true);
    }
  });

  it('turns away unmarked email on its own toggle, whatever the marker list says', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const server = fakeServer([mixedStream()]);

    // Blank markers is no marker filter, but the unmarked question is asked
    // separately and answered no — so every marked email arrives and the
    // unmarked one does not.
    const result = await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: [], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: server.http }),
    });

    expect(result.synced).toBe(3);
    expect(result.declined).toBe(1);
    expect(noteExists(vault, 'Notes/For art.md')).toBe(true);
    expect(noteExists(vault, 'Notes/Unmarked one.md')).toBe(false);
  });

  it('claims a marker however it was capitalised, spaced or repeated in settings', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const server = fakeServer([
      [
        { id: 3, subject: 'Shouted', vault: 'WORK' },
        { id: 2, subject: 'Whispered', vault: 'work' },
        { id: 1, subject: 'As typed', vault: 'Work' },
      ],
    ]);

    const result = await runSync({
      mode: 'fetch-new',
      settings: settings({
        // One marker, however badly the user typed the field.
        vaultMarkers: ['  work  ; WORK ;; Work'],
        receiveUnmarked: false,
      }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: server.http }),
    });

    expect(result.synced).toBe(3);
    expect(result.declined).toBe(0);
  });

  it('costs a declined email no detail request and no attachment download', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const server = fakeServer([
      [
        { id: 2, subject: 'Claimed', vault: 'Work', attachment: true },
        { id: 1, subject: 'Declined', vault: 'Art', attachment: true },
      ],
    ]);

    await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: server.http }),
    });

    expect(server.detailCalls).toEqual([2]);
    expect(server.attachmentCalls).toEqual([200]);
  });

  it('logs a decline with its marker, so a page of nothing but declines still stops the next scan', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const pages = [
      [
        { id: 4, subject: 'Art four', vault: 'Art' },
        { id: 3, subject: 'Art three', vault: 'Art' },
      ],
      [{ id: 2, subject: 'Work two', vault: 'Work' }],
    ];

    const first = fakeServer(pages);
    await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: first.http }),
    });

    // Page one was declined outright — and logged, marker and all.
    const stored = (await plugin.loadData()) as { 'fetch-log': Record<string, { status?: string; vaultMarker?: string }> };
    expect(stored['fetch-log']['4']).toMatchObject({ status: 'declined', vaultMarker: 'Art' });
    expect(stored['fetch-log']['2']).toMatchObject({ filename: 'Work two.md' });

    // A ledger of accepts only would hold nothing from page one, and the next
    // run would scan straight past it. Recording the declines is what stops it.
    const second = fakeServer(pages);
    const result = await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: second.http }),
    });

    expect(second.listCursors).toEqual([null]);
    expect(second.detailCalls).toEqual([]);
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it('imports what an earlier run declined once the markers widen, once and without a full re-fetch', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const pages = [
      [
        { id: 4, subject: 'Work four', vault: 'Work' },
        { id: 3, subject: 'Art three', vault: 'Art' },
      ],
      [{ id: 2, subject: 'Work two', vault: 'Work' }],
    ];

    const first = fakeServer(pages);
    await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: first.http }),
    });
    expect(noteExists(vault, 'Notes/Art three.md')).toBe(false);

    // The user notices `Art (1)` in settings and adds the marker.
    const second = fakeServer(pages);
    const result = await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work', 'Art'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: second.http }),
    });

    expect(result.synced).toBe(1);
    expect(noteExists(vault, 'Notes/Art three.md')).toBe(true);
    // No second copy of anything already imported, and no collision suffix.
    expect(noteExists(vault, 'Notes/Work four-1.md')).toBe(false);
    expect(second.detailCalls).toEqual([3]);

    // A third run has nothing left to release and stops on the first page.
    const third = fakeServer(pages);
    const after = await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work', 'Art'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: third.http }),
    });
    expect(third.listCursors).toEqual([null]);
    expect(after.synced).toBe(0);
  });

  it('leaves notes from an earlier run exactly where they are when the markers narrow', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const stream = [
      { id: 2, subject: 'Work two', vault: 'Work' },
      { id: 1, subject: 'Art one', vault: 'Art' },
    ];

    await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work', 'Art'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: fakeServer([stream]).http }),
    });
    const before = noteText(vault, 'Notes/Art one.md');

    await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({ apiKey: 'k', http: fakeServer([stream]).http }),
    });

    expect(noteExists(vault, 'Notes/Art one.md')).toBe(true);
    expect(noteText(vault, 'Notes/Art one.md')).toBe(before);
  });

  it('tells the user how much was not for this vault, and which markers it turned away', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    // Email 5 is already in the ledger, so this run has a skip as well as
    // claims and declines.
    await plugin.saveData({
      'fetch-log': { '5': { fetchedAt: '2021-01-05T00:00:00.000Z', filename: 'Old.md' } },
    });

    const notices: string[] = [];
    const result = await runSync({
      mode: 'fetch-new',
      settings: settings({ vaultMarkers: ['Work'], receiveUnmarked: false }),
      vault,
      plugin,
      client: createE2oClient({
        apiKey: 'k',
        http: fakeServer([
          [
            { id: 9, subject: 'Work nine', vault: 'Work' },
            { id: 8, subject: 'Art eight', vault: 'Art' },
            { id: 7, subject: 'Art seven', vault: 'art' },
            { id: 6, subject: 'Typo six', vault: 'Wrok' },
            { id: 5, subject: 'Already had this one', vault: 'Work' },
          ],
        ]).http,
      }),
      report: createSyncReport({ showNotice: (msg) => notices.push(msg), debugEnabled: false }),
    });

    expect(result.declined).toBe(3);
    expect(result.declinedByMarker).toEqual([
      { marker: 'Art', count: 2 },
      { marker: 'Wrok', count: 1 },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('1 added, 1 skipped, 3 not for this vault');
  });

  it('says nothing about declines in the notice when there were none', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));
    const notices: string[] = [];

    await runSync({
      mode: 'fetch-new',
      settings: settings(),
      vault,
      plugin,
      client: createE2oClient({
        apiKey: 'k',
        http: fakeServer([[{ id: 1, subject: 'Only one', vault: null }]]).http,
      }),
      report: createSyncReport({ showNotice: (msg) => notices.push(msg), debugEnabled: false }),
    });

    expect(notices[0]).toContain('1 added, 0 skipped, 0 errors');
    expect(notices[0]).not.toContain('not for this vault');
  });

  it('raises the starter-plan flag on an unmarked email still carrying its @@ token, and imports it as titled', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));

    const result = await runSync({
      mode: 'fetch-new',
      settings: settings(),
      vault,
      plugin,
      client: createE2oClient({
        apiKey: 'k',
        http: fakeServer([
          [
            { id: 2, subject: '@@Work Quarterly report', vault: null },
            { id: 1, subject: 'Ordinary subject', vault: null },
          ],
        ]).http,
      }),
    });

    expect(result.starterSignature).toBe(true);
    expect(result.synced).toBe(2);
    // The token is never re-read as a marker and never stripped from the title.
    expect(noteExists(vault, 'Notes/@@Work Quarterly report.md')).toBe(true);
    expect(noteText(vault, 'Notes/@@Work Quarterly report.md')).toContain(
      'email2obsidianVault: ""'
    );
  });

  it('leaves the starter-plan flag down on an ordinary stream', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));

    const result = await runSync({
      mode: 'fetch-new',
      settings: settings(),
      vault,
      plugin,
      client: createE2oClient({
        apiKey: 'k',
        http: fakeServer([[{ id: 1, subject: 'Ordinary', vault: 'Work' }]]).http,
      }),
    });

    expect(result.starterSignature).toBe(false);
  });
});
