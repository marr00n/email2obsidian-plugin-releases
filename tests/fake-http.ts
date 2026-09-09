import type { HttpAdapter, HttpRequest, HttpResponse } from '../src/api';

/**
 * A tiny in-memory pretend server for driving the real `E2oClient` through an
 * injected `HttpAdapter`, instead of mocking `src/api` away. Routes are
 * matched by method + pathname; the first match wins.
 */
export interface FakeRoute {
  /** Defaults to GET, matching every request the real client makes today. */
  method?: string;
  /** Tested against `new URL(request.url).pathname`. */
  pattern: RegExp;
  handler: (request: HttpRequest, url: URL) => HttpResponse | Promise<HttpResponse>;
}

export function createFakeHttp(routes: FakeRoute[]): HttpAdapter {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(request.url);
    const method = (request.method ?? 'GET').toUpperCase();

    for (const route of routes) {
      const routeMethod = (route.method ?? 'GET').toUpperCase();
      if (routeMethod !== method) continue;
      if (!route.pattern.test(url.pathname)) continue;
      return route.handler(request, url);
    }

    throw new Error(`No fake route matched ${method} ${url.pathname}`);
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    text,
    arrayBuffer: new TextEncoder().encode(text).buffer,
  };
}

export function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {}
): HttpResponse {
  return {
    status,
    headers,
    text,
    arrayBuffer: new TextEncoder().encode(text).buffer,
  };
}

export function binaryResponse(
  status: number,
  data: ArrayBuffer,
  headers: Record<string, string> = {}
): HttpResponse {
  return { status, headers, text: '', arrayBuffer: data };
}
