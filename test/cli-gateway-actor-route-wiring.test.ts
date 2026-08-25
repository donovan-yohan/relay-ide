import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('live hub shares approved operator handshake grants with CLI actor credential minting', () => {
  const indexSource = readFileSync(
    new URL('../server/index.ts', import.meta.url),
    'utf8'
  );
  const hubRouterCall = indexSource.slice(
    indexSource.indexOf('createHubNodeRouter({'),
    indexSource.indexOf('createRepoFeatureRouter({')
  );

  expect(hubRouterCall).toContain(
    'operatorHandshakeGrants: cliGatewayHandshakeGrantRegistry'
  );
});

test('lifecycle mutation routes reject read-only CLI actor credentials', () => {
  const indexSource = readFileSync(
    new URL('../server/index.ts', import.meta.url),
    'utf8'
  );

  expect(indexSource).toContain(
    'const requireCliGatewayWriteAuth: express.RequestHandler'
  );
  expect(indexSource).toContain('CLI_GATEWAY_ACTOR_WRITE_UNSUPPORTED');
  expect(indexSource).toContain(
    'CLI_GATEWAY_ACTOR_WORKTREE_STATUS_UNSUPPORTED'
  );
  expect(indexSource).toContain(
    "app.use('/workspaces', requireCliGatewayWriteAuth, workspaceRouter)"
  );
  expect(indexSource).toContain(
    'createWorkspaceGroupsRouter(CONFIG_PATH, requireCliGatewayWriteAuth'
  );
  expect(indexSource).toContain(
    "app.delete('/worktrees', requireCliGatewayWriteAuth, async (req, res) =>"
  );
});

test('native watch phase one marks its hand-rolled request as CLI gateway v1', () => {
  const cliSource = readFileSync(
    new URL('../bin/relay-ide.ts', import.meta.url),
    'utf8'
  );
  const watchStart = cliSource.indexOf(
    'async function runGatewaySessionNativeWatch'
  );
  const watchEnd = cliSource.indexOf(
    'async function runGatewaySessionGet',
    watchStart
  );
  expect(watchStart).toBeGreaterThan(-1);
  expect(watchEnd).toBeGreaterThan(watchStart);

  const watchSource = cliSource.slice(watchStart, watchEnd);
  expect(watchSource).toContain("'x-relay-cli-gateway': 'v1'");
  expect(watchSource).toContain(
    "'x-relay-cli-command': 'sessions.native.watch'"
  );
});

// #1428 regression tripwire: `requireCliGatewayEventsAuth` must keep
// `events.subscribe` as the expected actor command for EVERY /events topic.
// The CLI always sends that header (runGatewayEventsSubscribe); remapping it
// for `native-sessions` made classifyCliGatewayCredentialLane return
// 'unsupported-route' and 401 every scoped-actor CLI subscription. Native
// session scoping is enforced by the sessionId grant check, not this header.
test('events auth keeps events.subscribe as expected command for all topics', () => {
  const indexSource = readFileSync(
    new URL('../server/index.ts', import.meta.url),
    'utf8'
  );
  const gateStart = indexSource.indexOf('const requireCliGatewayEventsAuth');
  const gateEnd = indexSource.indexOf(
    'const requireCliGatewayWriteAuth: express.RequestHandler'
  );
  expect(gateStart).toBeGreaterThan(-1);
  expect(gateEnd).toBeGreaterThan(gateStart);
  const gateSource = indexSource.slice(gateStart, gateEnd);

  expect(gateSource).toContain("'events.subscribe'");
  // The exact regression shape: a conditional remap of the expected command
  // keyed on the native-sessions topic.
  expect(gateSource).not.toContain("? 'sessions.native.watch'");
});
