import { describe, it, expect, vi } from 'vitest';

import { processInlinePlaceholders, renderEmailMarkdown } from '../src/helpers';
import type { AttachmentMeta, EmailDetail } from '../src/api';

const saver = vi.fn(async (opts: any) => {
  const existing = saver.calls?.map((c: any) => c[0]?.suggestedName) || [];
  let filename = opts.suggestedName;
  let suffix = 1;
  while (existing.includes(filename)) {
    filename = `${opts.suggestedName}-${suffix}`;
    suffix += 1;
  }
  saver.calls = saver.calls || [];
  saver.calls.push([opts]);
  return { filename, path: `Assets/${filename}` };
});

describe('processInlinePlaceholders', () => {
  const emailBase: EmailDetail = {
    id: 1,
    subject: 'Subj',
    createdAt: '2021-01-01',
    hashtags: [],
    vaultMarker: null,
    markdownBody: '',
    attachments: [],
  };

  it('parses valid data URIs with whitespace and replaces with embeds', async () => {
    const email = {
      ...emailBase,
      markdownBody: 'Hello!\n![ alt ](  data:image/png;base64,QUJD  )',
    };

    const result = await processInlinePlaceholders(email, saver as any);

    expect(result.errors).toHaveLength(0);
    expect(result.body).toContain('![[Assets/alt.png]]');
    expect(result.inlineEmbeds[0]).toBe('Assets/alt.png');
  });

  it('rejects non-base64 URIs and preserves placeholder', async () => {
    const email = {
      ...emailBase,
      markdownBody: 'Test ![](data:image/png,aaaa)',
    };

    const result = await processInlinePlaceholders(email, saver as any);
    expect(result.errors).toHaveLength(1);
    expect(result.body).toContain('![](data:image/png,aaaa)');
  });

  it('records decode failure and preserves placeholder', async () => {
    const email = {
      ...emailBase,
      markdownBody: 'Broken ![](data:image/png;base64,****)',
    };

    const result = await processInlinePlaceholders(email, saver as any);
    expect(result.errors).toHaveLength(1);
    expect(result.body).toContain('![](data:image/png;base64,****)');
  });
});

describe('renderEmailMarkdown', () => {
  const inlineData = 'iVBORw0KGgo='; // minimal valid base64
  const email: EmailDetail = {
    id: 10,
    subject: 'Hello',
    createdAt: '2021-01-01',
    hashtags: ['tag'],
    vaultMarker: null,
    markdownBody: `Body ![](data:image/png;base64,${inlineData})`,
    attachments: [
      {
        id: 1,
        fileName: 'a.txt',
        fileSize: 1,
        mimeType: 'text/plain',
        createdAt: '2021',
        isInline: false,
      } as AttachmentMeta,
      {
        id: 2,
        fileName: 'inline.png',
        fileSize: 1,
        mimeType: 'image/png',
        createdAt: '2021',
        isInline: true,
      } as AttachmentMeta,
    ],
  };

  it('builds markdown with inline embeds and attachment list', async () => {
    const savedPaths = { 1: 'Notes/saved-a.txt' } as Record<number, string>;
    const renderResult = await renderEmailMarkdown(
      email,
      { noteFolder: 'Notes' },
      {
        savedPaths,
        inlineSaver: async (opts) => ({
          filename: opts.suggestedName,
          path: `Notes/${opts.suggestedName}`,
        }),
      }
    );

    expect(renderResult.markdown).toContain('## Email Attachments');
    expect(renderResult.markdown).toContain('[a.txt](Notes/saved-a.txt)');
    expect(renderResult.inlineEmbeds).toHaveProperty('0');
  });
});
