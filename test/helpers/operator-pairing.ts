import {
  NODE_PAIR_TOKEN_CREATE_CAPABILITY,
  NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE,
} from '../../shared/operator-handshake-grants.js';

export const TEST_PAIR_TOKEN_TASK_REF = 'test-node-pairing';

export interface MintPairTokenForTestOptions {
  displayName: string;
  taskRef?: string;
  actorId?: string;
}

async function responseBodyForMessage(response: Response): Promise<string> {
  try {
    return JSON.stringify(await response.json());
  } catch {
    return await response.text();
  }
}

async function expectStatus(
  response: Response,
  expectedStatus: number,
  action: string
): Promise<void> {
  if (response.status === expectedStatus) return;
  throw new Error(
    `${action} failed: expected ${expectedStatus}, got ${response.status}: ${await responseBodyForMessage(response)}`
  );
}

export async function mintPairTokenWithOperatorGrantForTest(
  base: string,
  options: MintPairTokenForTestOptions
): Promise<{ pairToken: string }> {
  const taskRef = options.taskRef ?? TEST_PAIR_TOKEN_TASK_REF;
  const actorId = options.actorId ?? 'test-node-pairing-cli';

  const grantRes = await fetch(`${base}/hub/operator-handshake-grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
    body: JSON.stringify({
      actor: { type: 'cli', id: actorId },
      issuer: { id: 'operator-browser' },
      audience: NODE_PAIR_TOKEN_MINT_GRANT_AUDIENCE,
      capabilities: [NODE_PAIR_TOKEN_CREATE_CAPABILITY],
      scope: { taskRefs: [taskRef] },
      ttlMs: 600_000,
    }),
  });
  await expectStatus(grantRes, 201, 'operator handshake grant request');
  const grantBody = (await grantRes.json()) as { grant: { id: string } };

  const approveRes = await fetch(
    `${base}/hub/operator-handshake-grants/${encodeURIComponent(grantBody.grant.id)}/approve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' },
      body: JSON.stringify({ approvedBy: { id: 'operator-browser' } }),
    }
  );
  await expectStatus(approveRes, 200, 'operator handshake grant approval');
  const approved = (await approveRes.json()) as { handle: string };

  const pairRes = await fetch(`${base}/hub/pair-tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-operator-grant': approved.handle,
      'x-relay-actor-type': 'cli',
      'x-relay-actor-id': actorId,
    },
    body: JSON.stringify({ displayName: options.displayName, taskRef }),
  });
  await expectStatus(pairRes, 201, 'pair-token creation');
  return (await pairRes.json()) as { pairToken: string };
}
