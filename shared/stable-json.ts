function compareJsonKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sortForJson(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sortForJson);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record).sort(([a], [b]) =>
      compareJsonKeys(a, b)
    )) {
      if (child !== undefined) sorted[key] = sortForJson(child);
    }
    return sorted;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForJson(value)) ?? 'null';
}

export function stableJsonEquals(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
