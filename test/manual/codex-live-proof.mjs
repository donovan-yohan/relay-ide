/* eslint-disable no-console -- console output is the entire point of this manual proof script */
/**
 * Manual, token-frugal live proof for the native Codex `app-server` adapter
 * (#1169, closes #301). NOT part of the automated suite — it spawns the REAL
 * `codex app-server` (this machine must be logged in) and spends real tokens.
 *
 * It drives the built `CodexNativeProtocolAdapter` directly through exactly ONE
 * hello-world round-trip and prints the emitted patch tail, the captured codex
 * thread id (the resumable provider-session id), the reconstructed assistant
 * text, and wall-clock TTFT. It tees the raw app-server stdout (JSON-RPC lines)
 * to an UNCOMMITTED temp file for local evidence only — a real transcript leaks
 * account/environment data and must never be committed.
 *
 * Usage (from the worktree root, after `npm run build:server`):
 *   RELAY_CODEX_LIVE_PROOF=1 node test/manual/codex-live-proof.mjs
 *
 * Capture one reasoning-enabled turn for a hand-sanitized structural fixture:
 *   RELAY_CODEX_LIVE_PROOF=1 RELAY_CODEX_REASONING_CAPTURE=1 \
 *     node test/manual/codex-live-proof.mjs
 */
import { spawn as nodeSpawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.env.RELAY_CODEX_LIVE_PROOF !== '1') {
  console.error(
    'Refusing to run: set RELAY_CODEX_LIVE_PROOF=1 to spend real tokens.'
  );
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(__dirname, '..', '..');
const { CodexNativeProtocolAdapter } = await import(
  path.join(
    worktreeRoot,
    'dist',
    'server',
    'protocol-adapters',
    'codex-native-adapter.js'
  )
);

const reasoningCapture = process.env.RELAY_CODEX_REASONING_CAPTURE === '1';
const reasoningEffort = process.env.RELAY_CODEX_REASONING_EFFORT || 'low';
const PROMPT = reasoningCapture
  ? 'Compute the sum of the squares from 1 through 40, factor the result into primes, and reply with exactly the prime factorization.'
  : 'Reply with exactly "ok" and nothing else.';
const rawChunks = [];

// Wrap the real spawn so we can tee stdout for a permanent (uncommitted)
// evidence transcript without disturbing the adapter's own reader.
const teeSpawn = (command, args, options) => {
  const child = nodeSpawn(command, args, options);
  child.stdout?.on('data', (chunk) => rawChunks.push(Buffer.from(chunk)));
  return child;
};

const adapter = new CodexNativeProtocolAdapter();
const patches = [];
let threadId = null;
let firstTokenAt = null;
let sentAt;

adapter.onPatch((patch) => {
  patches.push(patch);
  const ps =
    (patch.type === 'agent-session-snapshot-v2' &&
      patch.session?.providerSession?.threadId) ||
    (patch.type === 'agent-session-updated-v2' &&
      patch.providerSession?.threadId);
  if (ps) threadId = ps;
  if (
    firstTokenAt === null &&
    (patch.type === 'agent-item-delta-v2' ||
      (patch.type === 'agent-item-started-v2' &&
        patch.item?.type === 'assistantMessage'))
  ) {
    firstTokenAt = Date.now();
  }
});

const config = {
  cwd: os.tmpdir(),
  port: 0,
  sessionId: 'codex-live-proof',
  hookToken: 'live-proof',
  configDir: os.tmpdir(),
  // DI: the adapter forwards these capture-only settings to the app-server
  // client. They never alter Relay's production Codex defaults.
  extra: {
    spawn: teeSpawn,
    ...(reasoningCapture
      ? {
          args: [
            'app-server',
            '--listen',
            'stdio://',
            '-c',
            'model_reasoning_summary="detailed"',
            '-c',
            `model_reasoning_effort="${reasoningEffort}"`,
          ],
        }
      : {}),
  },
};

const TIMEOUT_MS = 120_000;

function waitForCompletion() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const done = patches.find((p) => p.type === 'agent-turn-completed-v2');
      if (done) {
        clearInterval(iv);
        resolve(done);
      }
      if (Date.now() - started > TIMEOUT_MS) {
        clearInterval(iv);
        reject(new Error(`timed out after ${TIMEOUT_MS}ms`));
      }
    }, 50);
  });
}

let exitCode = 0;
try {
  await adapter.connect(config);
  sentAt = Date.now();
  await adapter.sendMessage({ turnId: 'live-1', content: PROMPT });
  const completion = await waitForCompletion();

  const ttftMs = firstTokenAt ? firstTokenAt - sentAt : null;
  const totalMs = Date.now() - sentAt;

  let assistantText = '';
  for (const p of patches) {
    if (
      (p.type === 'agent-item-updated-v2' ||
        p.type === 'agent-item-started-v2') &&
      p.item?.type === 'assistantMessage' &&
      typeof p.item.text === 'string' &&
      p.item.text
    ) {
      assistantText = p.item.text;
    }
  }

  const tail = patches.slice(-10).map((p) => {
    if (p.type === 'agent-item-delta-v2' && reasoningCapture) {
      const deltaShape = Object.entries(p.delta)
        .map(([field, value]) => {
          const type = typeof value;
          const length =
            typeof value === 'string'
              ? Buffer.byteLength(value, 'utf8')
              : Array.isArray(value)
                ? value.length
                : null;
          return `${field}:${type}:length=${length ?? 'n/a'}`;
        })
        .join(',');
      return `${p.type}(${deltaShape})`;
    }
    if (p.type === 'agent-item-delta-v2')
      return `${p.type}(${JSON.stringify(p.delta)})`;
    if (p.type === 'agent-turn-completed-v2')
      return `${p.type}(status=${p.status})`;
    if (
      p.type === 'agent-item-updated-v2' ||
      p.type === 'agent-item-started-v2'
    )
      return `${p.type}(${p.item?.type})`;
    return p.type;
  });

  // Save the raw transcript for LOCAL evidence only, to an uncommitted temp
  // file. NEVER write it into test/fixtures/ — a real app-server transcript can
  // leak private account/environment data.
  const rawPath = path.join(
    os.tmpdir(),
    `relay-codex-${reasoningCapture ? 'reasoning-' : ''}live-proof-${process.pid}.jsonl`
  );
  fs.writeFileSync(rawPath, Buffer.concat(rawChunks));

  console.log(
    JSON.stringify(
      {
        ok:
          completion.type === 'agent-turn-completed-v2' &&
          completion.status === 'completed',
        completionStatus: completion.status ?? completion.type,
        ...(reasoningCapture
          ? {
              assistantTextPresent: assistantText.length > 0,
              threadIdPresent:
                typeof threadId === 'string' && threadId.length > 0,
            }
          : { assistantText, threadId }),
        ttftMs,
        totalMs,
        patchCount: patches.length,
        patchTail: tail,
        rawTranscript: rawPath,
        usage: completion.usage ?? null,
      },
      null,
      2
    )
  );
  if (
    completion.type !== 'agent-turn-completed-v2' ||
    completion.status !== 'completed'
  ) {
    exitCode = 1;
  }
} catch (err) {
  exitCode = 1;
  console.error('LIVE PROOF FAILED:', err?.stack ?? err);
  console.error(
    'patch tail:',
    patches.slice(-8).map((p) => p.type)
  );
  const errPatch = patches.find((p) => p.type === 'agent-error-v2');
  if (errPatch) console.error('adapter error:', errPatch.message);
} finally {
  await adapter.disconnect().catch(() => {});
  setTimeout(() => process.exit(exitCode), 100).unref();
}
