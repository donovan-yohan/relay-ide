import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('live hub shares approved operator handshake grants with CLI actor credential minting', () => {
  const indexSource = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const hubRouterCall = indexSource.slice(
    indexSource.indexOf('createHubNodeRouter({'),
    indexSource.indexOf('createRepoFeatureRouter({')
  );

  expect(hubRouterCall).toContain(
    'operatorHandshakeGrants: cliGatewayHandshakeGrantRegistry'
  );
});

test('lifecycle mutation routes reject read-only CLI actor credentials', () => {
  const indexSource = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');

  expect(indexSource).toContain('const requireCliGatewayWriteAuth: express.RequestHandler');
  expect(indexSource).toContain('CLI_GATEWAY_ACTOR_WRITE_UNSUPPORTED');
  expect(indexSource).toContain("app.use('/workspaces', requireCliGatewayWriteAuth, workspaceRouter)");
  expect(indexSource).toContain(
    'createWorkspaceGroupsRouter(CONFIG_PATH, requireCliGatewayWriteAuth'
  );
  expect(indexSource).toContain(
    "app.delete('/worktrees', requireCliGatewayWriteAuth, async (req, res) =>"
  );
});
