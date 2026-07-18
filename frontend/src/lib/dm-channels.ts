// DM-as-channel derivation (#1166, epic #1163). A "direct message" is not a
// distinct backend entity — it is a regular `workspace_topics` channel whose id
// follows a deterministic per-(workspace, framework) formula. DM-ness is a pure
// client-side derivation from the topic's id + `routingDefaults.providerId`, so
// no `WorkspaceTopicChannelKind` enum extension or server marker is required.
//
// See channel-ui-spec §0.2/§0.3 and §3.1.
import { createWorkspaceTopicId } from '../../../shared/workspace-topics.js';
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import type { WorkspaceTopicCreateInput } from '../../../shared/workspace-topics.js';

/** Local-workspace sentinel already used by TopicComposer when no IA workspace is active. */
export const DM_DEFAULT_WORKSPACE_ID = 'workspace:local';

/** Deterministic per-(workspace, framework) DM channel id. Pure, no I/O. */
export function dmChannelTopicId(
  providerId: string,
  workspaceId: string | null
): string {
  return createWorkspaceTopicId(
    `dm-${providerId}`,
    workspaceId ?? DM_DEFAULT_WORKSPACE_ID
  );
}

/**
 * A topic is a DM iff its id matches the deterministic formula for its OWN
 * `routingDefaults.providerId`. Recomputes the id — no string-prefix guessing,
 * no server-side marker needed. Returns the provider id when true, else null.
 */
export function isDmChannel(
  topic: Pick<WorkspaceTopic, 'id' | 'workspaceId' | 'routingDefaults'>
): string | null {
  const providerId = topic.routingDefaults?.providerId;
  if (!providerId) return null;
  return topic.id === dmChannelTopicId(providerId, topic.workspaceId)
    ? providerId
    : null;
}

/** Build the POST /workspace-topics body for a new DM channel. */
export function dmChannelCreateInput(input: {
  providerId: string;
  providerDisplayName: string;
  workspaceId: string | null;
}): WorkspaceTopicCreateInput {
  const workspaceId = input.workspaceId ?? DM_DEFAULT_WORKSPACE_ID;
  return {
    id: dmChannelTopicId(input.providerId, workspaceId),
    workspaceId,
    title: input.providerDisplayName,
    visibility: 'default',
    routingDefaults: { providerId: input.providerId },
  };
}
