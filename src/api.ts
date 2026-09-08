/* global console */
import { requestUrl, RequestUrlResponse } from 'obsidian';

export const EMAIL2OBSIDIAN_API_BASE = 'https://email2obsidian.com/';

export type SortOrder = 'date-desc' | 'date-asc';

export interface EmailSummary {
  id: number;
  subject: string;
  createdAt: string;
  hashtags: string[];
}

export interface EmailListRequest {
  apiKey: string;
  cursor?: string;
  sort?: SortOrder;
  tag?: string;
  search?: string;
}

export interface EmailListResponse {
  emails: EmailSummary[];
  hasMore: boolean;
  nextCursor?: string | null;
  tags?: string[];
}

export interface AttachmentMeta {
  id: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
  contentDisposition: 'inline' | 'attachment';
}

export interface EmailDetail extends EmailSummary {
  emailId?: string;
  markdownBody: string;
  expiresAt?: string;
  attachments: AttachmentMeta[];
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

export async function listEmails(
  params: EmailListRequest
): Promise<EmailListResponse> {
  const url = new URL('api/emails', EMAIL2OBSIDIAN_API_BASE);
  if (params.cursor) url.searchParams.set('cursor', params.cursor);
  if (params.sort) url.searchParams.set('sort', params.sort);
  if (params.tag) url.searchParams.set('tag', params.tag);
  if (params.search) url.searchParams.set('search', params.search);

  const response = await safeFetch(url.toString(), params.apiKey, 'GET /api/emails');
  const data = await parseJson(response, 'GET /api/emails');

  if (!isEmailListResponse(data)) {
    throw new ApiError(
      'bad-response',
      'GET /api/emails returned an unexpected shape.'
    );
  }

  return data;
}

export async function getEmail(
  id: number,
  apiKey: string
): Promise<EmailDetail> {
  const url = new URL(`api/emails/${id}`, EMAIL2OBSIDIAN_API_BASE);
  const response = await safeFetch(url.toString(), apiKey, 'GET /api/emails/:id');
  const data = await parseJson(response, 'GET /api/emails/:id');

  if (!isEmailDetailResponse(data)) {
    throw new ApiError(
      'bad-response',
      'GET /api/emails/:id returned an unexpected shape.'
    );
  }

  return data;
}

export async function downloadAttachment(
  id: number,
  apiKey: string,
  expectedFileName?: string
): Promise<AttachmentDownload> {
  const url = new URL(`api/attachments/${id}/download`, EMAIL2OBSIDIAN_API_BASE);
  const response = await safeFetch(
    url.toString(),
    apiKey,
    'GET /api/attachments/:id/download'
  );

  const disposition = getHeader(response.headers, 'content-disposition');
  const mimeType = getHeader(response.headers, 'content-type') ?? 'application/octet-stream';
  const contentLengthRaw = getHeader(response.headers, 'content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined;
  const data = response.arrayBuffer;

  return {
    data,
    mimeType,
    contentLength,
    disposition,
    fileName:
      expectedFileName ??
      extractFilenameFromDisposition(disposition) ??
      `attachment-${id}`,
  };
}

async function safeFetch(
  url: string,
  apiKey: string,
  context: string
): Promise<RequestUrlResponse> {
  let response: RequestUrlResponse;
  try {
    response = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
      },
    });
  } catch (error) {
    const message = `${context} failed: ${(error as Error).message}`;
    console.warn(`[Email2Obsidian] ${message}`);
    throw new ApiError('network', message);
  }

  if (response.status < 200 || response.status >= 300) {
    const friendly = friendlyErrorMessage(response.status, context);
    console.warn(`[Email2Obsidian] ${friendly}`);
    throw new ApiError(mapStatusToCode(response.status), friendly, response.status);
  }

  return response;
}

async function parseJson(
  response: RequestUrlResponse,
  context: string
): Promise<unknown> {
  try {
    return JSON.parse(response.text);
  } catch {
    const message = `${context} returned non-JSON response.`;
    console.warn(`[Email2Obsidian] ${message}`);
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

function isEmailListResponse(data: unknown): data is EmailListResponse {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.emails)) return false;
  if (typeof obj.hasMore !== 'boolean') return false;
  return true;
}

function isEmailDetailResponse(data: unknown): data is EmailDetail {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== 'number') return false;
  if (typeof obj.subject !== 'string') return false;
  if (!Array.isArray(obj.hashtags)) return false;
  if (typeof obj.markdownBody !== 'string') return false;
  if (!Array.isArray(obj.attachments)) return false;
  return true;
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
