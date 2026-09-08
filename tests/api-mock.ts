import { vi } from 'vitest';

/**
 * The shared src/api mock. Three network calls are replaced; everything else
 * stays real, so `ApiError` is the class src/pipeline catches on rather than
 * an undefined the `instanceof` check chokes on.
 *
 * Use it as:
 *
 *   vi.mock('../src/api', async () => (await import('./api-mock')).apiMock());
 */
export const mockListEmails = vi.fn();
export const mockGetEmail = vi.fn();
export const mockDownloadAttachment = vi.fn();

export async function apiMock(): Promise<typeof import('../src/api')> {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    listEmails: (...args: unknown[]) => mockListEmails(...args),
    getEmail: (...args: unknown[]) => mockGetEmail(...args),
    downloadAttachment: (...args: unknown[]) => mockDownloadAttachment(...args),
  } as typeof import('../src/api');
}

export function resetApiMocks(): void {
  mockListEmails.mockReset();
  mockGetEmail.mockReset();
  mockDownloadAttachment.mockReset();
}
