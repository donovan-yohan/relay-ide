import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export type SafeRegexTestResult =
  | { kind: 'ok'; matched: boolean }
  | { kind: 'unknown'; reason: string };

/**
 * Run a regex test off the hub event loop with a hard time budget.
 *
 * Safety properties:
 * - The regex executes in a worker thread. If it exceeds `timeoutMs`, the worker
 *   is terminated and the result becomes `unknown` (cannot block the hub loop).
 * - Callers MUST still validate patterns at parse time; this only enforces a
 *   bounded execution time.
 */
export async function safeRegexTest(
  pattern: string,
  text: string,
  options: { timeoutMs: number }
): Promise<SafeRegexTestResult> {
  const jsUrl = new URL('./safe-regex-worker.js', import.meta.url);
  const tsUrl = new URL('./safe-regex-worker.ts', import.meta.url);
  const workerUrl = fs.existsSync(fileURLToPath(jsUrl)) ? jsUrl : tsUrl;
  const worker = new Worker(workerUrl);

  try {
    const result = await new Promise<
      { ok: true; matched: boolean } | { ok: false; error: string }
    >((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: 'timeout' });
      }, options.timeoutMs);

      worker.once('message', (value: unknown) => {
        clearTimeout(timer);
        if (!value || typeof value !== 'object') {
          resolve({ ok: false, error: 'invalid worker response' });
          return;
        }
        const rec = value as Record<string, unknown>;
        if (rec['ok'] === true && typeof rec['matched'] === 'boolean') {
          resolve({ ok: true, matched: rec['matched'] });
          return;
        }
        if (rec['ok'] === false && typeof rec['error'] === 'string') {
          resolve({ ok: false, error: rec['error'] });
          return;
        }
        resolve({ ok: false, error: 'invalid worker response' });
      });

      worker.once('error', (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      void worker.postMessage({ pattern, text });
    });

    if (result.ok) return { kind: 'ok', matched: result.matched };
    if (result.error === 'timeout') {
      try {
        await worker.terminate();
      } catch {
        // ignore
      }
      return { kind: 'unknown', reason: 'regex match timed out' };
    }
    return { kind: 'unknown', reason: `regex match failed: ${result.error}` };
  } finally {
    // Best-effort cleanup; terminate is safe even after completion.
    try {
      await worker.terminate();
    } catch {
      // ignore
    }
  }
}
