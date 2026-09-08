import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runSync } from '../src/pipeline';
import type { Plugin as ObsidianPlugin, Vault as ObsidianVault } from 'obsidian';
import { Vault, Plugin, App } from './obsidian-fakes';
import {
  mockListEmails,
  mockGetEmail,
  mockDownloadAttachment,
  resetApiMocks,
} from './api-mock';

vi.mock('../src/api', async () => (await import('./api-mock')).apiMock());

beforeEach(() => {
  resetApiMocks();
});

describe('pipeline runSync', () => {
  it('combines attachment and inline saving with resolved paths', async () => {
    const vault = new Vault();
    const plugin = new Plugin(new App(vault));

    mockListEmails.mockResolvedValue({
      emails: [{ id: 1, subject: 'Hi', createdAt: '2021', hashtags: [] }],
      hasMore: false,
    });

    mockGetEmail.mockResolvedValue({
      id: 1,
      subject: 'Hi',
      createdAt: '2021',
      hashtags: [],
      markdownBody: 'Body ![](data:text/plain;base64,QQ==)',
      attachments: [
        { id: 10, fileName: 'doc.txt', fileSize: 1, mimeType: 'text/plain', createdAt: '2021', contentDisposition: 'attachment' },
        { id: 11, fileName: 'inline.png', fileSize: 1, mimeType: 'image/png', createdAt: '2021', contentDisposition: 'inline' },
      ],
    });

    mockDownloadAttachment.mockResolvedValue({ data: new Uint8Array([1]).buffer, mimeType: 'text/plain', fileName: 'doc.txt' });

    const result = await runSync(
      {
        mode: 'fetch-new',
        settings: { apiKey: 'k', notesFolder: 'Notes' },
        vault: vault as unknown as ObsidianVault,
        plugin: plugin as unknown as ObsidianPlugin,
      },
      () => {}
    );

    expect(result.attachmentErrors).toHaveLength(0);
    expect(result.synced).toBe(1);
    expect(vault.getAbstractFileByPath('Notes/doc.txt')).toBeTruthy();
    expect(vault.getAbstractFileByPath('Notes/inline-1-0.txt')).toBeTruthy();
  });
});
