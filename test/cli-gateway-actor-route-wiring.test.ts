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
