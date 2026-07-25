export const CLI_ACTOR_ORCHESTRATOR_ROLE_UNSUPPORTED =
  'CLI_ACTOR_ORCHESTRATOR_ROLE_UNSUPPORTED' as const;

export type ActorSessionCreateRolePolicy =
  | { ok: true; explicitRole: undefined }
  | {
      ok: false;
      explicitRole: 'orchestrator';
      reasonCode: typeof CLI_ACTOR_ORCHESTRATOR_ROLE_UNSUPPORTED;
    };

/**
 * Actor-created sessions are workers. Agent roster defaults are display hints,
 * so only a caller's explicit durable role participates in this policy.
 */
export function actorSessionCreateRolePolicy(
  body: Readonly<Record<string, unknown>>
): ActorSessionCreateRolePolicy {
  if (body['role'] !== 'orchestrator') {
    return { ok: true, explicitRole: undefined };
  }
  return {
    ok: false,
    explicitRole: 'orchestrator',
    reasonCode: CLI_ACTOR_ORCHESTRATOR_ROLE_UNSUPPORTED,
  };
}
