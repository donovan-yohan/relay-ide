export interface MockResponse {
  json?: unknown;
  status?: number;
  headers?: Record<string, string>;
  throw?: Error;
}

/**
 * Creates a mock fetch function from a map of URL substrings → response sequences.
 * Each call to a matching URL pops the next response from the front of that sequence.
 *
 * Throw detection: uses `'throw' in next` (property-existence check, more robust than
 * a falsy check so an explicit `throw: undefined` does not accidentally trigger).
 *
 * Body: `next.json` is serialized when present/non-null; otherwise the body is ''.
 *
 * Headers: the `Content-Type: application/json` default is merged with any extra
 * headers supplied via `next.headers`.
 */
export function createMockFetch(
  urlMap: Record<string, MockResponse[]>
): typeof globalThis.fetch {
  const queues = new Map<string, MockResponse[]>(
    Object.entries(urlMap).map(([k, v]) => [k, [...v]])
  );

  return async (
    input: RequestInfo | URL,
    _init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    for (const [pattern, queue] of queues) {
      if (url.includes(pattern)) {
        const next = queue.shift();
        if (!next) {
          throw new Error(
            `Mock fetch: exhausted responses for pattern "${pattern}", url: ${url}`
          );
        }
        if ('throw' in next) {
          throw next.throw;
        }

        const status = next.status ?? 200;
        const body = next.json != null ? JSON.stringify(next.json) : '';
        const responseHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          ...next.headers,
        };
        return new Response(body, { status, headers: responseHeaders });
      }
    }

    throw new Error(`Mock fetch: no pattern matched url: ${url}`);
  };
}
