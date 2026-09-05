import { writeFileSync } from 'node:fs';

globalThis.fetch = async (url, init = {}) => {
  const body =
    typeof init.body === 'string' && init.body.length > 0
      ? JSON.parse(init.body)
      : undefined;
  const capturePath = process.env.RELAY_TEST_FETCH_CAPTURE;
  if (!capturePath) {
    throw new Error('RELAY_TEST_FETCH_CAPTURE is required');
  }
  writeFileSync(
    capturePath,
    JSON.stringify({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body,
    })
  );
  const agentProfile = {
    id: 'agent-profile:hermes:0001',
    providerId: 'hermes',
    displayName: 'Tako Planner',
    avatar: null,
    hermesProfile: 'tako-planner',
    hermesApiKeySet: true,
    isDefault: false,
    isBuiltIn: false,
  };
  const member = {
    kind: 'agent',
    id: 'agent-profile:codex:default',
    joinedAt: '2026-08-31T00:00:00.000Z',
    invitedBy: 'agent:claude',
  };
  // #1455 slice 3: the per-profile credential lifecycle. Checked BEFORE the
  // `/agent-profiles` branch, which would otherwise swallow these routes.
  const credential = {
    profileId: 'agent-profile:hermes:0001',
    credentialId: 'sac-0001',
    actorId: 'agent-profile:hermes:0001',
    capabilities: ['session:read', 'context:read', 'context:write'],
    issuedAt: '2026-08-31T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z',
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null,
    state: 'active',
  };
  const data = String(url).includes('/credential')
    ? { credential, token: 'relay-sac-v1.sac-0001.[REDACTED]' }
    : String(url).includes('/members')
      ? {
          channelId: 'topic:general',
          members: [member],
          member,
          removed: member,
        }
      : String(url).includes('/agent-profiles')
        ? { profile: agentProfile, profiles: [agentProfile] }
        : String(url).includes('/channels/wait')
          ? {
              run: { id: 'chrun:test', state: 'completed' },
              outcome: 'completed',
              finalText: 'ok',
              contract: null,
            }
          : String(url).includes('/channels/runs/') &&
              String(url).includes('/history')
            ? { run: { id: 'chrun:test', state: 'completed' }, items: [] }
            : String(url).includes('/channels/')
              ? {
                  message: { id: 'chm:test' },
                  run: {
                    id: 'chrun:test',
                    channelId: 'topic:test',
                    threadId: null,
                    requestMessageId: 'chm:test',
                    requesterId: 'actor:test',
                    state: 'submitted',
                    targets: [],
                    createdAt: '2026-08-12T00:00:00.000Z',
                    updatedAt: '2026-08-12T00:00:00.000Z',
                  },
                }
              : {
                  id: 'worker-session',
                  type: 'terminal',
                  mode: 'pty',
                  agent: 'terminal',
                  cwd: '/repo',
                  status: 'active',
                };
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
