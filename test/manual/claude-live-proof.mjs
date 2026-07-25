/* eslint-disable no-console -- console output is the entire point of this manual proof script */
/**
 * Manual, token-frugal live proof for the Claude persistent-subprocess adapter
 * (#1168). NOT part of the automated suite — it invokes the REAL `claude` CLI
 * (this machine must be logged in) and spends real tokens.
 *
 * It drives the built adapter directly through exactly ONE hello-world DM
 * round-trip and prints the emitted patch tail, the captured claude session_id,
 * and wall-clock TTFT. It also tees the raw stream-json transcript to an
 * UNCOMMITTED temp file for local evidence — the committed replay fixture at
 * test/fixtures/claude-stream/hello.jsonl is hand-sanitized and must never be
 * overwritten by a real transcript (it leaks home path / plugin list / account
 * state). Do not point this at the committed fixture path.
 *
 * Usage (from the worktree root, after `npm run build:server`):
 *   RELAY_CLAUDE_LIVE_PROOF=1 node test/manual/claude-live-proof.mjs
 */
import { spawn as nodeSpawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.env.RELAY_CLAUDE_LIVE_PROOF !== '1') {
  console.error(
    'Refusing to run: set RELAY_CLAUDE_LIVE_PROOF=1 to spend real tokens.'
  );
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(__dirname, '..', '..');
const { ClaudeProtocolAdapter } = await import(
  path.join(
    worktreeRoot,
    'dist',
    'server',
    'protocol-adapters',
    'claude-adapter.js'
  )
);

const PROMPT = 'Reply with exactly "ok" and nothing else.';
const rawChunks = [];

// Wrap the real spawn so we can tee stdout for a permanent evidence transcript
// without disturbing the adapter's own reader (multiple 'data' listeners fan out).
const teeSpawn = (command, args, options) => {
  const child = nodeSpawn(command, args, options);
  child.stdout?.on('data', (chunk) => rawChunks.push(Buffer.from(chunk)));
  return child;
};

const adapter = new ClaudeProtocolAdapter(teeSpawn);
const patches = [];
let sessionId = null;
let firstTokenAt = null;
let sentAt;

adapter.onPatch((patch) => {
  patches.push(patch);
  if (
    patch.type === 'agent-session-updated-v2' &&
    patch.providerSession?.claudeSessionId
  ) {
    sessionId = patch.providerSession.claudeSessionId;
  }
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
  cwd: worktreeRoot,
  port: 0,
  sessionId: 'claude-live-proof',
  hookToken: 'live-proof',
  configDir: os.tmpdir(),
};

const TIMEOUT_MS = 120_000;

function waitForCompletion() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const done = patches.find((p) => p.type === 'agent-turn-completed-v2');
      const err = patches.find((p) => p.type === 'agent-error-v2');
      if (done) {
        clearInterval(iv);
        resolve(done);
      } else if (err && !done) {
        // an error may still precede a failed completion; keep waiting briefly
        if (patches.some((p) => p.type === 'agent-turn-completed-v2')) {
          clearInterval(iv);
          resolve(err);
        }
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

  // Reconstruct the assistant text from item updates.
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
  // file. NEVER write it into test/fixtures/ — a real transcript leaks private
  // account/environment data (home path, plugin list, billing state). The
  // committed replay fixture there is hand-sanitized.
  const rawPath = path.join(
    os.tmpdir(),
    `relay-claude-live-proof-${process.pid}.jsonl`
  );
  fs.writeFileSync(rawPath, Buffer.concat(rawChunks));

  console.log(
    JSON.stringify(
      {
        ok:
          completion.type === 'agent-turn-completed-v2' &&
          completion.status === 'completed',
        completionStatus:
          completion.type === 'agent-turn-completed-v2'
            ? completion.status
            : completion.type,
        assistantText,
        sessionId,
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
  // The registry keeps an unref'd sweep timer; exit explicitly.
  setTimeout(() => process.exit(exitCode), 100).unref();
}
