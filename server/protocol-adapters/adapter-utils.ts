/** Shared helpers for protocol adapters — extracts common field accessors. */

export function strField(
  data: Record<string, unknown> | undefined,
  key: string,
  fallback = ''
): string {
  return String(data?.[key] ?? fallback);
}

export function objField(
  data: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const val = data?.[key];
  return typeof val === 'object' && val !== null
    ? (val as Record<string, unknown>)
    : undefined;
}
