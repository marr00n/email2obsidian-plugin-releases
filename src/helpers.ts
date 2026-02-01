import type { EmailDetail, AttachmentMeta } from './api';
import type { AttachmentSaveError, InlineAttachmentContext } from './attachments';
import { buildAttachmentBase, toAttachmentSaveError } from './attachments';

export interface InlinePlaceholderResult {
  body: string;
  inlineEmbeds: Record<number, string>;
  inlineMeta: InlineAttachmentContext[];
  errors: AttachmentSaveError[];
}

export type InlineBinarySaver = (opts: {
  data: ArrayBuffer;
  suggestedName: string;
  mimeType?: string | null;
}) => Promise<{ filename: string; path: string }>;

export interface FilenameResult {
  filename: string;
  nextSuffix: number;
}

/**
 * Generate a safe filename from subject + createdAt. If collisions occur,
 * append -1, -2, ... until unique within the provided existing set.
 */
export function safeFilename(
  subject: string,
  createdAt: string,
  existingNames: Set<string>
): FilenameResult {
  const base = sanitizeFilename(subject || createdAt || 'email');
  let candidate = `${base}.md`;
  let suffix = 1;

  while (existingNames.has(candidate)) {
    candidate = `${base}-${suffix}.md`;
    suffix += 1;
  }

  return { filename: candidate, nextSuffix: suffix };
}

export interface RenderPaths {
  noteFolder: string;
}

export interface RenderedMarkdown {
  markdown: string;
  inlineEmbeds: Record<number, string>;
  inlineErrors: AttachmentSaveError[];
}

export interface RenderMarkdownOptions {
  savedPaths?: Record<number, string>;
  inlineSaver: InlineBinarySaver;
}

export async function processInlinePlaceholders(
  email: EmailDetail,
  saveBinary: InlineBinarySaver
): Promise<InlinePlaceholderResult> {
  const body = email.markdownBody ?? '';
  const pattern = /!\[\s*([^\]]*?)\s*\]\s*\(\s*(data:[^)]+?)\s*\)/gims;

  let lastIndex = 0;
  let placeholderIndex = 0;
  let output = '';

  const inlineEmbeds: Record<number, string> = {};
  const inlineMeta: InlineAttachmentContext[] = [];
  const errors: AttachmentSaveError[] = [];

  const matches = Array.from(body.matchAll(pattern)) as RegExpMatchArray[];
  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    const matchEnd = matchIndex + match[0].length;
    const altRaw = (match[1] ?? '').trim();
    const dataUriRaw = (match[2] ?? '').trim();

    const context: InlineAttachmentContext = {
      emailId: email.id,
      placeholderIndex,
      dataUriSnippet: dataUriRaw.slice(0, 80),
      altText: altRaw || null,
    };

    inlineMeta.push(context);
    output += body.slice(lastIndex, matchIndex);

    const parsed = parseDataUri(dataUriRaw);
    if (!parsed.ok) {
      errors.push(toAttachmentSaveError(context, parsed.error));
      output += match[0];
      placeholderIndex += 1;
      lastIndex = matchEnd;
      continue;
    }

    context.mimeType = parsed.mimeType;

    let binary: ArrayBuffer;
    try {
      binary = decodeBase64ToArrayBuffer(parsed.base64Data);
    } catch (error) {
      errors.push(toAttachmentSaveError(context, error));
      output += match[0];
      placeholderIndex += 1;
      lastIndex = matchEnd;
      continue;
    }

    const baseName = buildAttachmentBase({
      source: 'inline',
      emailId: email.id,
      index: placeholderIndex,
      suggestedName: altRaw || undefined,
      mimeType: parsed.mimeType ?? undefined,
    });

    try {
      const saved = await saveBinary({
        data: binary,
        suggestedName: baseName,
        mimeType: parsed.mimeType,
      });

      inlineEmbeds[placeholderIndex] = saved.path;
      output += `![[${normalizeLinkPath(saved.path)}]]`;
    } catch (error) {
      errors.push(toAttachmentSaveError(context, error));
      output += match[0];
    }

    placeholderIndex += 1;
    lastIndex = matchEnd;
  }

  output += body.slice(lastIndex);

  return { body: output, inlineEmbeds, inlineMeta, errors };
}

/**
 * Build markdown with frontmatter, body replacements for inline attachments,
 * and a trailing Attachments section for non-inline files.
 */
export async function renderEmailMarkdown(
  email: EmailDetail,
  paths: RenderPaths,
  options: RenderMarkdownOptions
): Promise<RenderedMarkdown> {
  const tags = Array.from(new Set([...(email.hashtags || []), 'email2obsidian']));
  const frontmatter = [
    '---',
    `title: "${escapeFrontmatter(email.subject)}"`,
    `created: ${email.createdAt}`,
    `tags: [${tags.join(', ')}]`,
    `email2obsidianID: ${email.id}`,
    '---',
  ].join('\n');

  const fallbackFolder = paths.noteFolder;

  const shouldProcessInline =
    typeof email.markdownBody === 'string' &&
    email.markdownBody.includes('data:') &&
    email.markdownBody.includes('![');

  const inlineResult = shouldProcessInline
    ? await processInlinePlaceholders(email, options.inlineSaver)
    : {
        body: email.markdownBody ?? '',
        inlineEmbeds: {},
        inlineMeta: [],
        errors: [],
      };

  const nonInline = (email.attachments || []).filter(
    (att) => att.contentDisposition !== 'inline'
  );

  const attachmentSection = nonInline.length
    ? buildAttachmentSection(nonInline, options.savedPaths, fallbackFolder)
    : '';

  const markdown = [frontmatter, '', inlineResult.body.trimEnd(), attachmentSection]
    .filter(Boolean)
    .join('\n\n');

  return {
    markdown,
    inlineEmbeds: inlineResult.inlineEmbeds,
    inlineErrors: inlineResult.errors,
  };
}

function sanitizeFilename(input: string): string {
  const cleaned = input
    .replace(/[\\/*?"<>|]+/g, ' ')
    .replace(/:/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length ? cleaned : 'email';
}

function escapeFrontmatter(input: string): string {
  return input.replace(/"/g, '\\"');
}

function buildAttachmentSection(
  attachments: AttachmentMeta[],
  savedPaths: Record<number, string> | undefined,
  fallbackFolder: string
): string {
  const lines = ['## Email Attachments', ''];
  for (const att of attachments) {
    const savedPath = savedPaths?.[att.id];
    if (savedPath) {
      lines.push(`- [${att.fileName}](${normalizeLinkPath(savedPath)})`);
      continue;
    }
    const linkPath = buildAttachmentLink(fallbackFolder, att.fileName);
    lines.push(`- [${att.fileName}](${linkPath})`);
  }
  return lines.join('\n');
}

function buildAttachmentLink(folder: string, filename: string): string {
  const cleanFolder = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return cleanFolder ? `${cleanFolder}/${filename}` : filename;
}

function normalizeLinkPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseDataUri(
  raw: string
): { ok: true; mimeType: string | null; base64Data: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('data:')) {
    return { ok: false, error: 'Inline data URI is malformed' };
  }

  const commaIndex = trimmed.indexOf(',');
  if (commaIndex === -1) {
    return { ok: false, error: 'Inline data URI is malformed' };
  }

  const header = trimmed.slice(5, commaIndex);
  const data = trimmed.slice(commaIndex + 1);

  const parts = header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);

  const hasBase64 = parts.some((part) => part.toLowerCase() === 'base64');
  if (!hasBase64) {
    return { ok: false, error: 'Inline data URI is not base64' };
  }

  const mimeType = parts.find(
    (part) => part.length && part.toLowerCase() !== 'base64' && !part.includes('=')
  );

  return { ok: true, mimeType: mimeType ?? null, base64Data: data };
}

function decodeBase64ToArrayBuffer(data: string): ArrayBuffer {
  const cleaned = data.replace(/\s+/g, '');
  if (!cleaned.length) {
    return new ArrayBuffer(0);
  }

  if (/[^A-Za-z0-9+/=]/.test(cleaned)) {
    throw new Error('Inline data URI is not valid base64');
  }

  const atobFn = typeof globalThis.atob === 'function' ? globalThis.atob : null;
  if (atobFn) {
    const binary = atobFn(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  const bufferCtor = typeof globalThis.Buffer === 'function' ? globalThis.Buffer : null;
  if (!bufferCtor) {
    throw new Error('Base64 decoding is unavailable in this environment');
  }

  const buffer = bufferCtor.from(cleaned, 'base64');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
