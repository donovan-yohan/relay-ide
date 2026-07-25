// DM-as-channel derivation (#1166, epic #1163). A "direct message" is not a
// distinct backend entity — it is a regular `workspace_topics` channel whose id
// follows a deterministic per-(workspace, framework) formula. DM-ness is a pure
// client-side derivation from the topic's id + `routingDefaults.providerId`, so
// no `WorkspaceTopicChannelKind` enum extension or server marker is required.
//
// See channel-ui-spec §0.2/§0.3 and §3.1.
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import type { WorkspaceTopicCreateInput } from '../../../shared/workspace-topics.js';

/** Local-workspace sentinel already used by TopicComposer when no IA workspace is active. */
export const DM_DEFAULT_WORKSPACE_ID = 'workspace:local';

// A DM id is namespaced with `~` separators. `createWorkspaceTopicId` (the same
// function the server uses to mint a topic id from its user-chosen title) slugs
// every id down to `[a-z0-9._-]` — it can NEVER emit a `~`, though `~` is legal
// per the topic-id grammar (`/^topic:[A-Za-z0-9._~%-]+$/`). Building the DM id
// directly with `~` therefore puts it in an id sub-namespace that no ordinary
// title can collide with (a topic literally titled "dm claude" would otherwise
// mint `topic:...-dm-claude`, the exact old DM id).
const DM_ID_MARKER = 'dm~';

/** Slug a provider/workspace segment to the title-id charset (no `~`, no `%`). */
function slugifyDmSegment(part: string): string {
  return part
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Deterministic per-(workspace, framework) DM channel id. Pure, no I/O. */
export function dmChannelTopicId(
  providerId: string,
  workspaceId: string | null
): string {
  const provider = slugifyDmSegment(providerId) || 'agent';
  const workspace =
    slugifyDmSegment(workspaceId ?? DM_DEFAULT_WORKSPACE_ID) || 'workspace';
  return `topic:${DM_ID_MARKER}${provider}~${workspace}`;
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
