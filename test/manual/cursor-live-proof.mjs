/* eslint-disable no-console -- console output is the entire point of this manual proof script */
/**
 * Manual live proof for the Cursor ACP adapter (#1552).
 * NOT part of the automated suite — it invokes the REAL `cursor-agent` CLI
 * (this machine must be logged in) and spends real tokens.
 *
 * Spawns a throwaway Relay hub on a dynamic free port, creates a channel topic
 * bound to @cursor, drives 2 consecutive turns (CURSOR_LIVE_OK + continuity check),
 * and prints the verbatim channel history.
 *
 * Usage (from the worktree root, after `npm run build`):
 *   RELAY_CURSOR_LIVE_PROOF=1 node test/manual/cursor-live-proof.mjs
 */
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.RELAY_CURSOR_LIVE_PROOF !== '1') {
  console.error(
    'Refusing to run: set RELAY_CURSOR_LIVE_PROOF=1 to spend real tokens.'
  );
  process.exit(2);
}

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(__dirname, '..', '..');

/** Mirrors `relayAppDataDir()` in server/runtime-state-paths.ts. */
function relayAppDataDir() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'relay-ide');
}

/**
 * The hub publishes its port-keyed local actor token into the SHARED app-data
 * root (`$XDG_CONFIG_HOME/relay-ide` when absolute, else `~/.config/relay-ide`)
 * and refuses to publish it at all when its config dir sits outside that root
 * (`configDirIsShared`, server/local-hub-actor-token.ts). So the throwaway
 * config dir goes UNDER that root — it is never redirected there by setting
 * `XDG_CONFIG_HOME` for the hub: the hub passes its environment to every agent
 * CLI it spawns, and `cursor-agent` reads its login from
 * `$XDG_CONFIG_HOME/cursor/auth.json`. Redirecting it leaves the live agent
 * silently logged out, so `session/prompt` never settles and the proof hangs
 * forever instead of failing. The dir and the token file are removed on exit.
 */
const PROOF_ROOT = relayAppDataDir();
const PROOF_DIR = path.join(PROOF_ROOT, `proof-cursor-${Date.now()}`);
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
    `[cursor-live-proof] Preparing throwaway hub config on port ${PORT}...`
  );
  await rm(PROOF_DIR, { recursive: true, force: true });
  await mkdir(PROOF_DIR, { recursive: true });

  const configPath = path.join(PROOF_DIR, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      port: PORT,
      host: '127.0.0.1',
      repos: [worktreeRoot],
    })
  );

  console.log(`[cursor-live-proof] Starting throwaway hub on port ${PORT}...`);
  const hub = spawn(
    process.execPath,
    [path.join(worktreeRoot, 'dist', 'server', 'index.js')],
    {
      cwd: worktreeRoot,
      env: {
        ...process.env,
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

  // Wait for hub token file to be published
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (!existsSync(tokenPath)) continue;
    try {
      const tokenContent = JSON.parse(await readFile(tokenPath, 'utf8'));
      if (tokenContent?.token) {
        hubToken = tokenContent.token;
        console.log('[cursor-live-proof] Discovered hub token.');
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

  // Wait for hub readiness
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

  console.log('[cursor-live-proof] Hub is ready.');

  // Match on `sender.providerId`, the field the channel row actually carries.
  // `sender.displayName` is the PROVIDER DESCRIPTOR's label, not the provider
  // id ('Cursor', 'DeepSeek Harness'), and there is no `sender.role`/
  // `sender.framework` at all — matching those silently never fires. Rows with
  // no text are the agent's detail cards (command output, file changes); the
  // assistant message is the one with a body.
  function findAgentMessages(messages) {
    return messages.filter(
      (m) => m.sender?.providerId === 'cursor' && (m.body?.text || m.text)
    );
  }

  async function pollTurn(channelId, turnIndex, expectedToken) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
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
    // 1. Create workspace topic channel bound to cursor
    console.log('[cursor-live-proof] Creating workspace topic with @cursor...');
    const topicRes = await runCli([
      'v1',
      'workspace-topics',
      'create',
      '--input-json',
      JSON.stringify({
        workspaceId: 'ws:local',
        title: 'Cursor Proof Channel',
        provider: 'cursor',
        cwd: worktreeRoot,
      }),
    ]);

    if (!topicRes.ok) {
      throw new Error(
        `Failed to create topic: ${JSON.stringify(topicRes.error)}`
      );
    }

    const channelId = topicRes.data.topic.id;
    console.log(`[cursor-live-proof] Created channel topic: ${channelId}`);

    // 2. Turn 1: Run shell echo CURSOR_LIVE_OK
    console.log('[cursor-live-proof] Sending Turn 1: @cursor prompt...');
    const post1 = await runCli([
      'v1',
      'channels',
      'post',
      '--input-json',
      JSON.stringify({
        channelId,
        text: '@cursor Run `echo CURSOR_LIVE_OK` in the shell and reply with only its output.',
      }),
    ]);

    if (!post1.ok) {
      throw new Error(`Failed to post Turn 1: ${JSON.stringify(post1.error)}`);
    }

    console.log('[cursor-live-proof] Awaiting Turn 1 completion...');
    const turn1Text = await pollTurn(channelId, 0, 'CURSOR_LIVE_OK');
    if (!turn1Text) {
      throw new Error('Turn 1 did not complete with CURSOR_LIVE_OK');
    }
    console.log(`[cursor-live-proof] Turn 1 OK: "${turn1Text.trim()}"`);

    // 3. Turn 2: Continuity Check
    console.log('[cursor-live-proof] Sending Turn 2: Continuity check...');
    const post2 = await runCli([
      'v1',
      'channels',
      'post',
      '--input-json',
      JSON.stringify({
        channelId,
        text: '@cursor What exact token did you just echo? Reply with only the token.',
      }),
    ]);

    if (!post2.ok) {
      throw new Error(`Failed to post Turn 2: ${JSON.stringify(post2.error)}`);
    }

    console.log('[cursor-live-proof] Awaiting Turn 2 completion...');
    const turn2Text = await pollTurn(channelId, 1, 'CURSOR_LIVE_OK');
    if (!turn2Text) {
      throw new Error('Turn 2 did not complete with CURSOR_LIVE_OK continuity');
    }
    console.log(`[cursor-live-proof] Turn 2 OK: "${turn2Text.trim()}"`);

    // 4. Verbatim channel history
    console.log('\n--- VERBATIM CHANNEL HISTORY ---');
    const finalHist = await runCli([
      'v1',
      'channels',
      'history',
      '--channel-id',
      channelId,
    ]);
    console.log(JSON.stringify(finalHist, null, 2));

    console.log('\n[cursor-live-proof] Live proof PASSED.');
  } finally {
    hub.kill('SIGTERM');
    await new Promise((r) => hub.on('close', r));
    await rm(PROOF_DIR, { recursive: true, force: true });
    if (existsSync(tokenPath)) {
      await rm(tokenPath, { force: true });
    }
  }
}

main().catch((err) => {
  console.error('[cursor-live-proof] FAILED:', err);
  process.exit(1);
});
