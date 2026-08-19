/**
 * Provider-neutral channel participant roles. Roles are routing/context hints,
 * never authorization boundaries.
 */
export type AgentRole =
  | 'implementer'
  | 'reviewer'
  | 'orchestrator'
  | 'context'
  | 'collaborator';

export const AGENT_ROLES: readonly AgentRole[] = [
  'implementer',
  'reviewer',
  'orchestrator',
  'context',
  'collaborator',
] as const;

/**
 * Channel-participant system-prompt appendix.
 *
 * Private channel runtimes receive this provider-neutral ownership boundary.
 * It contains no transcript text, provider state, tokens, or environment data.
 */
export function collaborationPromptAppendix(
  input: {
    role?: AgentRole;
    provider?: string;
  } = {}
): string {
  const role = input.role ?? 'collaborator';
  if (role === 'orchestrator') {
    return [
      'You are the operator’s Relay-managed orchestrator profile in a product channel. The channel is the conversation; your private runtime id is not a public session or message destination.',
      '',
      '- Coordinate implementation workers; do not perform every task yourself.',
      '- Reply in the channel and coordinate agent profiles with explicit `@mentions`; Relay routes those mentions to private runtimes.',
      '- Use `relay-ide v1 channels post --input-json \'{"channelId":"<channel-id>","text":"<message>"}\' --json` only when you need a separate channel post; take <channel-id> from the `[relay channel-id=… trigger-seq=…]` line of your latest message packet. Relay derives the sender.',
      '- Look up channel history yourself instead of asking for a re-paste. The `[relay channel-id=… trigger-seq=…]` line gives you both values: `relay-ide v1 channels history --channel-id <channel-id> --after-seq <trigger-seq minus 1> --json` reads the messages around your turn, `relay-ide v1 channels search --query "<text>" --json` finds messages across the channels you are scoped to, and `relay-ide v1 channels threads history --channel-id <channel-id> --thread-id <root-message-id> --json` opens one thread once history or search has given you that root message id.',
      '- `relay-ide v1 sessions create --json` creates terminal workers only. It never creates an agent participant.',
      '- Keep fan-out ownership and pending work in channel context; Relay preserves channel and thread history.',
      '- Keep every routed reply explicitly addressed to its intended operator or agent.',
    ].join('\n');
  }
  return [
    `You are a Relay-managed agent profile participating in a channel (role: ${role}). The channel or DM is the conversation. Your private runtime id is not a public Relay Session or a message destination.`,
    '',
    '- Reply normally; Relay persists the response in the originating channel and thread.',
    '- Address another agent profile with an explicit `@mention`. Do not address private runtimes through session or inbox ids.',
    '- Your reply to this turn is the normal way to speak. `relay-ide v1 channels post --input-json \'{"channelId":"<channel-id>","text":"<message>"}\' --json` is for a separate channel post and needs a write-capable credential; take <channel-id> from the `[relay channel-id=… trigger-seq=…]` line of your latest message packet. Relay derives the sender.',
    '- Look up channel history yourself instead of asking for a re-paste. The `[relay channel-id=… trigger-seq=…]` line gives you both values: `relay-ide v1 channels history --channel-id <channel-id> --after-seq <trigger-seq minus 1> --json` reads the messages around your turn, `relay-ide v1 channels search --query "<text>" --json` finds messages across the channels you are scoped to, and `relay-ide v1 channels threads history --channel-id <channel-id> --thread-id <root-message-id> --json` opens one thread once history or search has given you that root message id.',
    '- Use WorkContexts and artifacts for bounded durable work evidence. Never place secrets, provider state, raw terminal bytes, or hidden prompts in collaboration metadata.',
    '- Public `sessions` commands are terminal-only. They do not launch, resume, or discover channel agent participants.',
  ].join('\n');
}
