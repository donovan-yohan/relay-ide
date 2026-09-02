/* eslint-disable no-console -- console output is the entire point of this manual proof script */
/**
 * Manual, token-frugal live proof for the Cursor ACP adapter (#1552).
 * NOT part of the automated suite — it invokes the REAL `cursor-agent` CLI
 * (this machine must be logged in) and spends real tokens.
 *
 * It drives the built adapter directly through exactly ONE hello-world turn
 * round-trip and prints the emitted patch tail, the captured cursor session id,
 * and wall-clock TTFT.
 *
 * Usage (from the worktree root, after `npm run build`):
 *   RELAY_CURSOR_LIVE_PROOF=1 node test/manual/cursor-live-proof.mjs
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.RELAY_CURSOR_LIVE_PROOF !== '1') {
  console.error(
    'Refusing to run: set RELAY_CURSOR_LIVE_PROOF=1 to spend real tokens.'
  );
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(__dirname, '..', '..');
const { CursorProtocolAdapter } = await import(
  path.join(
    worktreeRoot,
    'dist',
    'server',
    'protocol-adapters',
    'cursor-adapter.js'
  )
);

const PROMPT = 'Reply with exactly "ok" and nothing else.';
const adapter = new CursorProtocolAdapter();
const patches = [];
let sessionId = null;
let firstTokenAt = null;
let sentAt;

adapter.onPatch((patch) => {
  patches.push(patch);
  if (
    patch.type === 'agent-session-snapshot-v2' &&
    patch.session?.providerSession?.cursorSessionId
  ) {
    sessionId = patch.session.providerSession.cursorSessionId;
  }
  if (
    patch.type === 'agent-session-updated-v2' &&
    patch.providerSession?.cursorSessionId
  ) {
    sessionId = patch.providerSession.cursorSessionId;
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
  sessionId: 'cursor-live-proof',
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
        if (patches.some((p) => p.type === 'agent-turn-completed-v2')) {
          clearInterval(iv);
          resolve(patches.find((p) => p.type === 'agent-turn-completed-v2'));
          return;
        }
        clearInterval(iv);
        reject(
          new Error(`Adapter emitted agent-error-v2: ${JSON.stringify(err)}`)
        );
      } else if (Date.now() - started > TIMEOUT_MS) {
        clearInterval(iv);
        reject(
          new Error(`Timed out after ${TIMEOUT_MS}ms waiting for completion`)
        );
      }
    }, 100);
  });
}

async function main() {
  console.log('[cursor-live-proof] Connecting adapter...');
  await adapter.connect(config);
  console.log('[cursor-live-proof] Connected. Session ID:', sessionId);

  sentAt = Date.now();
  console.log(`[cursor-live-proof] Sending prompt: "${PROMPT}"`);
  await adapter.sendMessage({
    content: PROMPT,
    turnId: 'live-turn-1',
  });

  console.log('[cursor-live-proof] Awaiting completion...');
  const done = await waitForCompletion();
  const totalMs = Date.now() - sentAt;
  const ttftMs = firstTokenAt ? firstTokenAt - sentAt : null;

  console.log('\n--- LIVE PROOF SUMMARY ---');
  console.log('Session ID:', sessionId);
  console.log('Total latency:', `${totalMs}ms`);
  console.log('TTFT:', ttftMs ? `${ttftMs}ms` : 'n/a');
  console.log('Terminal status:', done.status ?? done.terminalStatus);
  console.log('Total patches emitted:', patches.length);

  const assistantItems = patches
    .filter(
      (p) =>
        p.type === 'agent-item-updated-v2' &&
        p.item?.type === 'assistantMessage'
    )
    .map((p) => p.item.text);
  console.log('Assistant text output:', assistantItems.join(''));

  await adapter.disconnect();
  console.log('[cursor-live-proof] Disconnected cleanly. PASSED.');
}

main().catch(async (err) => {
  console.error('[cursor-live-proof] FAILED:', err);
  try {
    await adapter.disconnect();
  } catch {
    // Ignore teardown errors on failure exit
  }
  process.exit(1);
});
