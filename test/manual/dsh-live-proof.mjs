/* eslint-disable no-console -- console output is the entire point of this manual proof script */
/**
 * Manual live proof for the dsh ACP adapter (#1535), rerun on the shared ACP base (#1554).
 * NOT part of the automated suite — it invokes the REAL `dsh` CLI and spends real tokens.
 *
 * Spawns a throwaway Relay hub on a dynamic free port, creates a channel topic
 * bound to @dsh, drives 2 consecutive turns (DSH_LIVE_OK + continuity check),
 * and prints the verbatim channel history.
 *
 * Usage (from the worktree root, after `npm run build`):
 *   RELAY_DSH_LIVE_PROOF=1 DEEPSEEK_API_KEY=... [DEEPSEEK_BASE_URL=...] \
 *     node test/manual/dsh-live-proof.mjs
 */
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.RELAY_DSH_LIVE_PROOF !== '1') {
  console.error(
    'Refusing to run: set RELAY_DSH_LIVE_PROOF=1 to spend real tokens.'
  );
  process.exit(2);
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error(
    'Refusing to run: DEEPSEEK_API_KEY must be set (dsh ACP lane is env-credentialed).'
  );
  process.exit(2);
}

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(__dirname, '..', '..');
const PROOF_PARENT = process.env.RELAY_PROOF_ROOT ?? '/tmp/acp-base-proof';
const PROOF_ROOT = path.join(PROOF_PARENT, 'relay-ide');
const PROOF_DIR = path.join(PROOF_ROOT, `proof-dsh-${Date.now()}`);
const CLI_PATH = path.join(worktreeRoot, 'dist', 'bin', 'relay-ide.js');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to get free port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let hubToken = null;
let PORT = 0;

async function runCli(args, env = {}) {
  const fullEnv = {
    ...process.env,
    XDG_CONFIG_HOME: PROOF_PARENT,
    RELAY_IDE_CONFIG: path.join(PROOF_DIR, 'config.json'),
    RELAY_IDE_PORT: String(PORT),
    ...(hubToken ? { RELAY_IDE_ACTOR_TOKEN: hubToken } : {}),
    ...env,
  };
  const { stdout, stderr } = await exec(
    process.execPath,
    [CLI_PATH, ...args, '--json'],
    {
      cwd: worktreeRoot,
      env: fullEnv,
    }
  );
  if (stderr && stderr.trim()) console.error('[cli stderr]', stderr.trim());
  return JSON.parse(stdout.trim());
}

async function main() {
  PORT = await getFreePort();
  console.log(
    `[dsh-live-proof] Preparing throwaway hub config on port ${PORT}...`
  );
  await rm(PROOF_DIR, { recursive: true, force: true });
  await mkdir(PROOF_DIR, { recursive: true });
  await mkdir(PROOF_ROOT, { recursive: true });

  const configPath = path.join(PROOF_DIR, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      repos: [worktreeRoot],
    })
  );

  console.log(`[dsh-live-proof] Starting throwaway hub on port ${PORT}...`);
  const hub = spawn(
    process.execPath,
    [path.join(worktreeRoot, 'dist', 'server', 'index.js')],
    {
      cwd: worktreeRoot,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: PROOF_PARENT,
        RELAY_IDE_CONFIG: configPath,
        RELAY_IDE_HOST: '127.0.0.1',
        RELAY_IDE_PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  hub.stdout.on('data', () => {});
  hub.stderr.on('data', () => {});

  const tokenPath = path.join(PROOF_ROOT, `local-actor-token-${PORT}.json`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!existsSync(tokenPath)) continue;
    try {
      const tokenContent = JSON.parse(await readFile(tokenPath, 'utf8'));
      if (tokenContent?.token) {
        hubToken = tokenContent.token;
        console.log('[dsh-live-proof] Discovered hub token.');
        break;
      }
    } catch {
      // Retry on transient read
    }
  }

  if (!hubToken) {
    hub.kill('SIGTERM');
    throw new Error('Hub failed to publish local actor token within 10s');
  }

  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const res = await runCli(['v1', 'workspace-topics', 'list']);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // Hub not ready yet
    }
  }

  if (!ready) {
    hub.kill('SIGTERM');
    throw new Error('Hub failed readiness check');
  }

  console.log('[dsh-live-proof] Hub is ready.');

  function findAgentMessages(messages) {
    return messages.filter(
      (m) =>
        (m.sender?.role === 'agent' ||
          m.sender?.framework === 'dsh' ||
          m.sender?.displayName === 'dsh') &&
        (m.body?.text || m.text)
    );
  }

  async function pollTurn(channelId, turnIndex, expectedToken) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const hist = await runCli([
        'v1',
        'channels',
        'history',
        '--channel-id',
        channelId,
      ]);
      if (!hist.ok || !Array.isArray(hist.data?.messages)) continue;
      const agentMsgs = findAgentMessages(hist.data.messages);
      if (agentMsgs.length <= turnIndex) continue;
      const target = agentMsgs[turnIndex];
      const txt = target.body?.text ?? target.text ?? '';
      if (target.status === 'complete' || txt.includes(expectedToken)) {
        return txt;
      }
    }
    return null;
  }

  try {
    console.log('[dsh-live-proof] Creating workspace topic with @dsh...');
    const topicRes = await runCli([
      'v1',
      'workspace-topics',
      'create',
      '--input-json',
      JSON.stringify({
        workspaceId: 'ws:local',
        title: 'dsh Proof Channel',
        provider: 'dsh',
        cwd: worktreeRoot,
      }),
    ]);

    if (!topicRes.ok) {
      throw new Error(
        `Failed to create topic: ${JSON.stringify(topicRes.error)}`
      );
    }

    const channelId = topicRes.data.topic.id;
    console.log(`[dsh-live-proof] Created channel topic: ${channelId}`);

    console.log('[dsh-live-proof] Sending Turn 1: @dsh prompt...');
    const post1 = await runCli([
      'v1',
      'channels',
      'post',
      '--input-json',
      JSON.stringify({
        channelId,
        text: '@dsh Run `echo DSH_LIVE_OK` in the shell and reply with only its output.',
      }),
    ]);
    if (!post1.ok) {
      throw new Error(`Failed to post Turn 1: ${JSON.stringify(post1.error)}`);
    }

    console.log('[dsh-live-proof] Awaiting Turn 1 completion...');
    const turn1Text = await pollTurn(channelId, 0, 'DSH_LIVE_OK');
    if (!turn1Text) throw new Error('Turn 1 did not complete with DSH_LIVE_OK');
    console.log(`[dsh-live-proof] Turn 1 OK: "${turn1Text.trim()}"`);

    console.log('[dsh-live-proof] Sending Turn 2: Continuity check...');
    const post2 = await runCli([
      'v1',
      'channels',
      'post',
      '--input-json',
      JSON.stringify({
        channelId,
        text: '@dsh What exact token did you just echo? Reply with only the token.',
      }),
    ]);
    if (!post2.ok) {
      throw new Error(`Failed to post Turn 2: ${JSON.stringify(post2.error)}`);
    }

    console.log('[dsh-live-proof] Awaiting Turn 2 completion...');
    const turn2Text = await pollTurn(channelId, 1, 'DSH_LIVE_OK');
    if (!turn2Text) {
      throw new Error('Turn 2 did not complete with DSH_LIVE_OK continuity');
    }
    console.log(`[dsh-live-proof] Turn 2 OK: "${turn2Text.trim()}"`);

    console.log('\n--- VERBATIM CHANNEL HISTORY ---');
    const finalHist = await runCli([
      'v1',
      'channels',
      'history',
      '--channel-id',
      channelId,
    ]);
    console.log(JSON.stringify(finalHist, null, 2));

    console.log('\n[dsh-live-proof] Live proof PASSED.');
  } finally {
    hub.kill('SIGTERM');
    await new Promise((r) => hub.on('close', r));
    await rm(PROOF_DIR, { recursive: true, force: true });
    if (existsSync(tokenPath)) await rm(tokenPath, { force: true });
  }
}

main().catch((err) => {
  console.error('[dsh-live-proof] FAILED:', err);
  process.exit(1);
});
