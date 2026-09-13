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

export interface RenderPaths {
  noteFolder: string;
}

export interface RenderedMarkdown {
  markdown: string;
  inlineEmbeds: Record<number, string>;
  inlineErrors: AttachmentSaveError[];
}

export interface RenderMarkdownOptions {
  /**
   * The email's non-inline attachments — the ones that get an Attachments
   * section entry. Partitioned once by the caller (see `writeEmailNote`);
   * this function does not re-filter.
   */
  nonInlineAttachments: AttachmentMeta[];
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
 * and a trailing Attachments section for the non-inline files the caller
 * supplies. Rendering the body can itself save files, via `inlineSaver`.
 */
export async function renderEmailMarkdown(
  email: EmailDetail,
  paths: RenderPaths,
  options: RenderMarkdownOptions
): Promise<RenderedMarkdown> {
  const tags = Array.from(new Set([...email.hashtags, 'email2obsidian']));
  const frontmatter = [
    '---',
    `title: ${yamlString(email.subject)}`,
    `created: ${email.createdAt}`,
    // Each tag quoted: bare, a tag holding a comma became two tags and one
    // holding brackets became a nested list.
    `tags: [${tags.map(yamlString).join(', ')}]`,
    `email2obsidianID: ${email.id}`,
    // ADR-0003: every note carries the Vault Marker it arrived under, so a
    // later cleanup or re-route can work locally. Written on every note and
    // left empty for an Unmarked Email rather than omitted, so a query over
    // the property needs no null branch.
    `email2obsidianVault: ${yamlString(email.vaultMarker ?? '')}`,
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

  const nonInline = options.nonInlineAttachments;

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

/**
 * A YAML double-quoted scalar, quotes included.
 *
 * Inside double quotes a backslash starts an escape sequence, so escaping
 * only the quote character left every other backslash to be read as one: a
 * subject naming a Windows path (`C:\Users\Name\report.docx`) produced
 * frontmatter that Obsidian could not parse at all, and the note arrived with
 * an empty or broken properties panel. A newline was the quieter version of
 * the same fault — legal YAML, but the subject came back folded onto one line.
 *
 * Double-quoted rather than single: it is the one YAML style that can carry
 * a line break, and the escapes below are only available here.
 */
function yamlString(input: string): string {
  const escaped = input
    // Backslash first, or it would escape the backslashes added below.
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // Whatever else the wire carried: a raw control character is not legal
    // in a double-quoted scalar, so it goes in as its escape.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (char) =>
      `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    );
  return `"${escaped}"`;
}

function buildAttachmentSection(
  attachments: AttachmentMeta[],
  savedPaths: Record<number, string> | undefined,
  fallbackFolder: string
): string {
  const lines = ['## Email Attachments', ''];
  for (const att of attachments) {
    const savedPath = savedPaths?.[att.id];
    const linkPath = savedPath
      ? normalizeLinkPath(savedPath)
      : buildAttachmentLink(fallbackFolder, att.fileName);
    lines.push(`- [${escapeLinkText(att.fileName)}](${escapeLinkTarget(linkPath)})`);
  }
  return lines.join('\n');
}

/**
 * A markdown link target, with the brackets that would end it early made
 * safe.
 *
 * Markdown closes `(...)` on the first unmatched `)`, so an attachment named
 * `report).pdf` cut its own link short and left the rest of the path as plain
 * text on the page. Balanced pairs — `Invoice (final).pdf` — parse correctly
 * and are left alone, so ordinary filenames read as they always have; only
 * the brackets that would break the link are encoded.
 */
function escapeLinkTarget(path: string): string {
  return isBracketBalanced(path)
    ? path
    : path.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** The visible half of the link: `[` and `]` would end it early too. */
function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1');
}

function isBracketBalanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth += 1;
    else if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
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
