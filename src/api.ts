/* global setTimeout */
import { requestUrl } from 'obsidian';
import { prefixedWarn } from './sync-report';

export const EMAIL2OBSIDIAN_API_BASE = 'https://email2obsidian.com/';

export type SortOrder = 'date-desc' | 'date-asc';

/**
 * Emails per page. The service defaults to 10 and clamps at 100, so asking
 * for the maximum is six times fewer round trips on a full fetch — and six
 * times fewer chances to be rate limited part way through one.
 */
const PAGE_LIMIT = 100;

/**
 * One retry, after a pause, for the failures that are the service being busy
 * rather than the request being wrong. Anything else — a bad key, a missing
 * email — will fail exactly the same way a second time.
 */
const RETRY_PAUSE_MS = 1000;

/**
 * The longest `Retry-After` this will actually sit out. Past it the service
 * is not asking for a pause, it is asking the user to come back later, and
 * the run says so instead of blocking on it.
 */
const MAX_RETRY_AFTER_MS = 10_000;

export type Sleep = (ms: number) => Promise<void>;

/* -------------------------------------------------------------------------
 * Transport
 *
 * The client talks to the service through an injectable adapter shaped like
 * Obsidian's `requestUrl`. Nothing else in the plugin performs HTTP.
 * ---------------------------------------------------------------------- */

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export type HttpAdapter = (request: HttpRequest) => Promise<HttpResponse>;

/* -------------------------------------------------------------------------
 * Domain values
 *
 * These are what the rest of the plugin sees. Wire quirks documented in
 * `docs/server-api-contract.md` — SQL timestamps, nullable `hashtags`,
 * nullable `contentDisposition`, the `vault` field carrying a Vault Marker —
 * are normalised away here and never travel further.
 * ---------------------------------------------------------------------- */

export interface EmailSummary {
  id: number;
  subject: string;
  /** ISO-like local timestamp, e.g. `2026-09-09T08:14:02` (no zone suffix). */
  createdAt: string;
  /** Never null: a missing or null wire value becomes `[]`. */
  hashtags: string[];
  /** The Vault Marker the sender put on the email, or null when unmarked. */
  vaultMarker: string | null;
}

export interface AttachmentMeta {
  id: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
  /** Derived from the wire `contentDisposition` (`'inline'`). */
  isInline: boolean;
}

export interface EmailDetail extends EmailSummary {
  emailId?: string;
  markdownBody: string;
  expiresAt?: string;
  attachments: AttachmentMeta[];
}

export interface EmailListRequest {
  cursor?: string;
  /**
   * Emails per page. Defaults to `PAGE_LIMIT`; the service clamps it to
   * 1–100 (`docs/server-api-contract.md`).
   */
  limit?: number;
  sort?: SortOrder;
  tag?: string;
  search?: string;
}

export interface EmailListResponse {
  emails: EmailSummary[];
  hasMore: boolean;
  nextCursor?: string | null;
  /** Hashtag facet over the account, not over the page. Opaque to the plugin. */
  tags?: string[];
}

export interface AttachmentDownload {
  data: ArrayBuffer;
  mimeType: string;
  contentLength?: number;
  fileName: string;
  disposition?: string | null;
}

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'server-error'
  | 'http-error'
  | 'bad-response'
  | 'network';

export class ApiError extends Error {
  code: ApiErrorCode;
  status?: number;

  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------
 * Service Client
 * ---------------------------------------------------------------------- */

export type DownloadAttachment = (
  id: number,
  expectedFileName?: string
) => Promise<AttachmentDownload>;

/**
 * The plugin's one handset to the Email2Obsidian service. It holds the API
 * key and the transport, and hands back domain values only.
 */
export interface E2oClient {
  listEmails(params?: EmailListRequest): Promise<EmailListResponse>;
  getEmail(id: number): Promise<EmailDetail>;
  downloadAttachment: DownloadAttachment;
}

export interface E2oClientOptions {
  apiKey: string;
  /** Defaults to Obsidian's `requestUrl`; injectable for tests. */
  http?: HttpAdapter;
  /**
   * Where transport and payload complaints go — pass a `SyncReport`'s `warn`
   * to route them through the sync's reporting seam. Messages arrive bare; the
   * default adds the plugin prefix itself so a client built without a report
   * still logs exactly as it always has.
   */
  warn?: (msg: string) => void;
  /** How the retry pause is taken. Injectable so tests need not really wait. */
  sleep?: Sleep;
}

export function createE2oClient({
  apiKey,
  http = obsidianHttp,
  warn = defaultWarn,
  sleep = defaultSleep,
}: E2oClientOptions): E2oClient {
  async function listEmails(
    params: EmailListRequest = {}
  ): Promise<EmailListResponse> {
    const url = new URL('api/emails', EMAIL2OBSIDIAN_API_BASE);
    url.searchParams.set('limit', String(params.limit ?? PAGE_LIMIT));
    if (params.cursor) url.searchParams.set('cursor', params.cursor);
    if (params.sort) url.searchParams.set('sort', params.sort);
    if (params.tag) url.searchParams.set('tag', params.tag);
    if (params.search) url.searchParams.set('search', params.search);

    const context = 'GET /api/emails';
    const response = await safeFetch(http, url.toString(), apiKey, context, warn, sleep);
    const data = parseJson(response, context, warn);

    if (!isEmailListPayload(data)) {
      throw new ApiError('bad-response', `${context} returned an unexpected shape.`);
    }

    return toEmailListResponse(data, warn);
  }

  async function getEmail(id: number): Promise<EmailDetail> {
    const url = new URL(`api/emails/${id}`, EMAIL2OBSIDIAN_API_BASE);
    const context = 'GET /api/emails/:id';
    const response = await safeFetch(http, url.toString(), apiKey, context, warn, sleep);
    const data = parseJson(response, context, warn);

    if (!isEmailDetailPayload(data)) {
      throw new ApiError('bad-response', `${context} returned an unexpected shape.`);
    }

    return toEmailDetail(data, warn);
  }

  async function downloadAttachment(
    id: number,
    expectedFileName?: string
  ): Promise<AttachmentDownload> {
    const url = new URL(`api/attachments/${id}/download`, EMAIL2OBSIDIAN_API_BASE);
    const response = await safeFetch(
      http,
      url.toString(),
      apiKey,
      'GET /api/attachments/:id/download',
      warn,
      sleep
    );

    const disposition = getHeader(response.headers, 'content-disposition');
    const mimeType =
      getHeader(response.headers, 'content-type') ?? 'application/octet-stream';
    const contentLengthRaw = getHeader(response.headers, 'content-length');
    const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined;

    return {
      data: response.arrayBuffer,
      mimeType,
      contentLength,
      disposition,
      fileName:
        expectedFileName ??
        extractFilenameFromDisposition(disposition) ??
        `attachment-${id}`,
    };
  }

  return { listEmails, getEmail, downloadAttachment };
}

/* -------------------------------------------------------------------------
 * Transport plumbing
 * ---------------------------------------------------------------------- */

/**
 * The default when no `SyncReport`-backed `warn` is supplied: the same
 * `[Email2Obsidian] ` prefix, from the one module that owns that literal.
 */
const defaultWarn = prefixedWarn;

/**
 * The default transport.
 *
 * Obsidian's `requestUrl` rejects on any status of 400 or above unless it is
 * told not to, so without `throw: false` a 401, a 429 or a 5xx never reaches
 * `safeFetch`'s status check: it arrives as a thrown `Error` and is filed as
 * `network`, with no status attached. Everything downstream that reads the
 * status — the friendly per-status messages here, and the rate-limit
 * discipline that stops a run and holds the ledger back — is then dead code.
 * Opting out is what turns an error response back into a response.
 */
const obsidianHttp: HttpAdapter = (request) =>
  requestUrl({ ...request, throw: false });

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, with one retry for the failures worth retrying.
 *
 * A rate limit, a 5xx and a dropped connection are all the service or the
 * network being momentarily unavailable, and a single hiccup used to abort
 * the whole run. Every other failure — a bad key, a missing email, a reply
 * that will not parse — fails identically the second time, so it is not
 * retried. When the service says how long to wait, that is what is waited;
 * `docs/server-api-contract.md` documents the header on a 429.
 */
async function safeFetch(
  http: HttpAdapter,
  url: string,
  apiKey: string,
  context: string,
  warn: (msg: string) => void,
  sleep: Sleep = defaultSleep
): Promise<HttpResponse> {
  const attempt = async (): Promise<HttpResponse> => {
    try {
      return await http({
        url,
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
        },
      });
    } catch (error) {
      throw new ApiError('network', `${context} failed: ${(error as Error).message}`);
    }
  };

  let response = await attempt().catch((error: unknown) => error as ApiError);

  const pause = retryPauseFor(response);
  if (pause !== null) {
    await sleep(pause);
    response = await attempt().catch((error: unknown) => error as ApiError);
  }

  if (response instanceof ApiError) {
    warn(response.message);
    throw response;
  }

  if (response.status < 200 || response.status >= 300) {
    const friendly = friendlyErrorMessage(response.status, context);
    warn(friendly);
    throw new ApiError(mapStatusToCode(response.status), friendly, response.status);
  }

  return response;
}

/**
 * How long to wait before trying this one again, or `null` when trying again
 * would only produce the same answer.
 */
function retryPauseFor(outcome: HttpResponse | ApiError): number | null {
  if (outcome instanceof ApiError) {
    // The request never landed. One more go covers a dropped connection.
    return outcome.code === 'network' ? RETRY_PAUSE_MS : null;
  }
  if (outcome.status === 429) {
    const asked = retryAfterMs(getHeader(outcome.headers, 'retry-after'));
    if (asked === null) return RETRY_PAUSE_MS;
    // A long wait is not a pause, it is "come back later" — say so instead of
    // holding the run open for it.
    return asked <= MAX_RETRY_AFTER_MS ? asked : null;
  }
  return outcome.status >= 500 ? RETRY_PAUSE_MS : null;
}

/** `Retry-After` in milliseconds — seconds or an HTTP date, per RFC 9110. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function parseJson(
  response: HttpResponse,
  context: string,
  warn: (msg: string) => void
): unknown {
  try {
    return JSON.parse(response.text);
  } catch {
    const message = `${context} returned non-JSON response.`;
    warn(message);
    throw new ApiError('bad-response', message, response.status);
  }
}

function friendlyErrorMessage(status: number, context: string): string {
  if (status === 401) {
    return `${context} unauthorized (401): Your API key didn’t work. Please double-check it. (Unauthorised 401).`;
  }
  if (status === 403) {
    return `${context} forbidden (403): This key can’t access these emails. Check you’re using the right account. (Forbidden 403).`;
  }
  if (status === 429) {
    return `${context} rate limited (429): You’ve hit the rate limit. Please wait a bit or lower the sync frequency. (Rate limited 429).`;
  }
  if (status >= 500) {
    return `${context} failed (${status}): The service is having trouble. Please try again later. Server error (5xx).`;
  }
  return `${context} failed (${status}): Request failed (status ${status}). Please retry.`;
}

function mapStatusToCode(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  return 'http-error';
}

function extractFilenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
  if (!matches || matches.length < 2) {
    return null;
  }
  const value = matches[1];
  if (!value) return null;
  const trimmed = value.trim().replace(/^"|"$/g, '');
  return trimmed.length ? trimmed : null;
}

function getHeader(headers: Record<string, string>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Wire shapes and normalisation
 *
 * Guards check only the invariants the contract promises (`docs/server-api-
 * contract.md`, "Invariants the plugin relies on"). Everything else is
 * coerced rather than rejected — notably `hashtags`, which is legitimately
 * null on legacy rows.
 * ---------------------------------------------------------------------- */

interface WireEmailListPayload {
  emails: unknown[];
  hasMore: boolean;
  nextCursor?: unknown;
  tags?: unknown;
}

interface WireEmailDetailPayload extends Record<string, unknown> {
  id: number;
  subject: string;
  markdownBody: string;
  attachments: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEmailListPayload(data: unknown): data is WireEmailListPayload {
  if (!isRecord(data)) return false;
  if (!Array.isArray(data.emails)) return false;
  if (typeof data.hasMore !== 'boolean') return false;
  return true;
}

function isEmailDetailPayload(data: unknown): data is WireEmailDetailPayload {
  if (!isRecord(data)) return false;
  if (typeof data.id !== 'number') return false;
  if (typeof data.subject !== 'string') return false;
  if (typeof data.markdownBody !== 'string') return false;
  if (!Array.isArray(data.attachments)) return false;
  return true;
}

function toEmailListResponse(
  payload: WireEmailListPayload,
  warn: (msg: string) => void
): EmailListResponse {
  const emails: EmailSummary[] = [];
  for (const entry of payload.emails) {
    const summary = toEmailSummary(entry);
    if (summary) {
      emails.push(summary);
      continue;
    }
    warn('GET /api/emails: skipped an unusable email entry.');
  }

  return {
    emails,
    hasMore: payload.hasMore,
    nextCursor:
      typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
    tags: normalizeStringArray(payload.tags),
  };
}

function toEmailSummary(entry: unknown): EmailSummary | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.id !== 'number') return null;
  if (typeof entry.subject !== 'string') return null;

  return {
    id: entry.id,
    subject: entry.subject,
    createdAt: normalizeTimestamp(entry.createdAt),
    hashtags: normalizeStringArray(entry.hashtags),
    vaultMarker: normalizeVaultMarker(entry.vault),
  };
}

function toEmailDetail(
  payload: WireEmailDetailPayload,
  warn: (msg: string) => void
): EmailDetail {
  const attachments: AttachmentMeta[] = [];
  for (const entry of payload.attachments) {
    const attachment = toAttachmentMeta(entry);
    if (attachment) {
      attachments.push(attachment);
      continue;
    }
    warn(`GET /api/emails/${payload.id}: skipped an unusable attachment entry.`);
  }

  const detail: EmailDetail = {
    id: payload.id,
    subject: payload.subject,
    createdAt: normalizeTimestamp(payload.createdAt),
    hashtags: normalizeStringArray(payload.hashtags),
    vaultMarker: normalizeVaultMarker(payload.vault),
    markdownBody: payload.markdownBody,
    attachments,
  };

  if (typeof payload.emailId === 'string') {
    detail.emailId = payload.emailId;
  }
  const expiresAt = normalizeTimestamp(payload.expiresAt);
  if (expiresAt) {
    detail.expiresAt = expiresAt;
  }

  return detail;
}

function toAttachmentMeta(entry: unknown): AttachmentMeta | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.id !== 'number') return null;

  return {
    id: entry.id,
    fileName: typeof entry.fileName === 'string' ? entry.fileName : '',
    fileSize: typeof entry.fileSize === 'number' ? entry.fileSize : 0,
    mimeType:
      typeof entry.mimeType === 'string' && entry.mimeType.length
        ? entry.mimeType
        : 'application/octet-stream',
    createdAt: normalizeTimestamp(entry.createdAt),
    isInline: entry.contentDisposition === 'inline',
  };
}

const SQL_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * The service sends SQL timestamps (`2026-09-09 08:14:02`). Swap the space
 * for a `T` so the value parses as a date everywhere downstream; deliberately
 * no timezone suffix is added, because the wire value carries no zone.
 */
function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const matches = SQL_TIMESTAMP.exec(trimmed);
  return matches ? `${matches[1]}T${matches[2]}` : trimmed;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length) items.push(trimmed);
  }
  return items;
}

function normalizeVaultMarker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
