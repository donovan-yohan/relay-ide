import { parentPort } from 'node:worker_threads';

function readMessage(value: unknown): { pattern: string; text: string } | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec['pattern'] !== 'string' || typeof rec['text'] !== 'string')
    return null;
  return { pattern: rec['pattern'], text: rec['text'] };
}

parentPort?.on('message', (msg: unknown) => {
  const parsed = readMessage(msg);
  if (!parsed) {
    parentPort?.postMessage({ ok: false, error: 'invalid worker message' });
    return;
  }
  try {
    // NOTE: flags must be embedded by the caller via inline modifiers.

    const re = new RegExp(parsed.pattern);
    const matched = re.test(parsed.text);
    parentPort?.postMessage({ ok: true, matched });
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
