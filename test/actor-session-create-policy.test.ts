import { describe, expect, it } from 'vitest';

import {
  actorSessionCreateRolePolicy,
  CLI_ACTOR_ORCHESTRATOR_ROLE_UNSUPPORTED,
} from '../server/actor-session-create-policy.js';

describe('actor session create role policy', () => {
  it.each(['hermes', 'codex', 'claude'])(
    'allows %s as a normal worker when no durable role is explicit',
    (agent) => {
      expect(
        actorSessionCreateRolePolicy({ agent, mode: 'web' })
      ).toEqual({
        ok: true,
        explicitRole: undefined,
      });
    }
  );

  it('denies an explicit durable orchestrator role', () => {
    expect(
      actorSessionCreateRolePolicy({
        agent: 'hermes',
        mode: 'web',
        role: 'orchestrator',
      })
    ).toEqual({
      ok: false,
      explicitRole: 'orchestrator',
      reasonCode: CLI_ACTOR_ORCHESTRATOR_ROLE_UNSUPPORTED,
    });
  });
});
