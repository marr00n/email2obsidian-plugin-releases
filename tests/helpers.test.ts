import { describe, it, expect, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

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
        nonInlineAttachments: email.attachments.filter((att) => !att.isInline),
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

describe('renderEmailMarkdown frontmatter', () => {
  const plain: EmailDetail = {
    id: 7,
    subject: 'Subj',
    createdAt: '2026-01-01T00:00:00',
    hashtags: [],
    vaultMarker: null,
    markdownBody: 'Body',
    attachments: [],
  };

  /**
   * Render, then read the frontmatter back the way Obsidian does. Asserting on
   * the string alone is what let a subject full of backslashes ship: the line
   * looked right and no parser ever saw it.
   */
  async function properties(
    overrides: Partial<EmailDetail>
  ): Promise<Record<string, unknown>> {
    const { markdown } = await renderEmailMarkdown(
      { ...plain, ...overrides },
      { noteFolder: 'Notes' },
      { nonInlineAttachments: [], savedPaths: {}, inlineSaver: async () => ({
        filename: 'x',
        path: 'Notes/x',
      }) }
    );
    const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
    expect(match).not.toBeNull();
    return parseYaml((match as RegExpExecArray)[1]) as Record<string, unknown>;
  }

  it('keeps a subject holding backslashes readable, and unchanged', async () => {
    // A forwarded email naming a Windows path. Inside double quotes a
    // backslash starts an escape sequence, so unescaped this produced
    // frontmatter Obsidian could not parse at all.
    const subject = String.raw`C:\Users\Name\report.docx`;

    expect(await properties({ subject })).toMatchObject({ title: subject });
  });

  it('keeps a subject holding a quote, a newline and a tab intact', async () => {
    const subject = 'Re: "urgent"\nsecond line\tafter a tab';

    expect(await properties({ subject })).toMatchObject({ title: subject });
  });

  it('keeps a Vault Marker holding a backslash intact', async () => {
    const props = await properties({ vaultMarker: String.raw`Work\Archive` });

    expect(props.email2obsidianVault).toBe(String.raw`Work\Archive`);
  });

  it('keeps a tag holding a comma or brackets as one tag', async () => {
    // Bare in a flow sequence, `a,b` became two tags and `[x]` a nested list.
    const props = await properties({ hashtags: ['a,b', '[x]', 'plain'] });

    expect(props.tags).toEqual(['a,b', '[x]', 'plain', 'email2obsidian']);
  });

  it('still writes an ordinary subject and tag list plainly', async () => {
    const props = await properties({ subject: 'Hello', hashtags: ['todo'] });

    expect(props).toEqual({
      title: 'Hello',
      created: '2026-01-01T00:00:00',
      tags: ['todo', 'email2obsidian'],
      email2obsidianID: 7,
      email2obsidianVault: '',
    });
  });
});
