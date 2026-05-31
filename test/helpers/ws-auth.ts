export const TEST_BROWSER_SESSION_TOKEN = 'test-browser-session-token';

export function testBrowserAuthTokens(): Set<string> {
  return new Set([TEST_BROWSER_SESSION_TOKEN]);
}

export function testBrowserWsHeaders(): { Cookie: string } {
  return { Cookie: `token=${encodeURIComponent(TEST_BROWSER_SESSION_TOKEN)}` };
}

export function testBrowserCookieHeader(): string {
  return `token=${encodeURIComponent(TEST_BROWSER_SESSION_TOKEN)}`;
}
