type BrowserIdCrypto = Pick<Crypto, 'randomUUID'> | undefined;

export function createBrowserIdWithCrypto(
  prefix: string,
  crypto: BrowserIdCrypto
): string {
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)
    .padEnd(8, '0')}`;
}

export function createBrowserId(prefix: string): string {
  return createBrowserIdWithCrypto(prefix, globalThis.crypto);
}
