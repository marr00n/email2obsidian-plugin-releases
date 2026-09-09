import { describe, it, expect, vi } from 'vitest';

import { runSync } from '../src/pipeline';
import { createE2oClient } from '../src/api';
import { createSyncReport } from '../src/sync-report';
import { Vault, Plugin, App, TFile } from 'obsidian';
import { createFakeHttp, jsonResponse, binaryResponse } from './fake-http';

function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function noteText(vault: Vault, path: string): string {
  const file = vault.getAbstractFileByPath(path);
  expect(file).toBeInstanceOf(TFile);
  return (file as TFile).text ?? '';
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
