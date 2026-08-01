// DM-as-channel derivation (#1166, epic #1163). A "direct message" is not a
// distinct backend entity — it is a regular `workspace_topics` channel whose id
// follows a deterministic per-(workspace, framework) formula. DM-ness is a pure
// client-side derivation from the topic's id + `routingDefaults.providerId`, so
// no `WorkspaceTopicChannelKind` enum extension or server marker is required.
//
// See channel-ui-spec §0.2/§0.3 and §3.1.
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import type { WorkspaceTopicCreateInput } from '../../../shared/workspace-topics.js';
import {
  isLocalWorkspaceRef,
  normalizeWorkspaceId,
} from '../../../shared/workspace.js';

/**
 * Slug segment a DM id uses for the local workspace. This is the LEGACY
 * `workspace:local` sentinel slug, deliberately frozen (#1287 slice 2): the DM
 * id is the `workspace_topics` id, and `channel_messages.channel_id` keys
 * transcript history off it. Re-deriving local DM ids to `ws-local` would mint
 * new channels and strand every existing DM's history behind the boot
 * `sweepOrphans` pass. The row's `workspaceId` COLUMN moves to the real seeded
 * workspace; the id does not.
 */
const DM_LOCAL_WORKSPACE_SEGMENT = 'workspace-local';

// A DM id is namespaced with `~` separators. No other id-minting path can emit
// a `~`, though `~` is legal per the topic-id grammar
// (`/^topic:[A-Za-z0-9._~%-]+$/`): `createWorkspaceTopicId` (deterministic
// derived rows, plus every grandfathered title-slugged row) slugs down to
// `[a-z0-9._-]`, and `mintWorkspaceTopicId` (#1287 slice 4, every new free-
// titled chat) emits lowercase Crockford base32 only. Building the DM id
// directly with `~` therefore puts it in an id sub-namespace nothing else can
// collide with (a legacy topic titled "dm claude" would otherwise have minted
// `topic:...-dm-claude`, the exact old DM id).
const DM_ID_MARKER = 'dm~';

/**
 * Length budget for one `~`-separated segment of a DM id.
 *
 * TRUNCATION IS LOSSY, SO THE INPUTS MUST BE BOUNDED. Two workspace ids that
 * share the first `DM_SEGMENT_MAX` slug characters derive the SAME DM id, and
 * `getOrCreateDmChannel` fetches by that id before creating — so a collision
 * silently reuses another workspace's DM row and files the conversation in the
 * wrong lane. The id cannot simply be re-derived to fix that later: it IS the
 * `workspace_topics` id and `channel_messages.channel_id` keys transcript
 * history off it (`docs/LEARNINGS.md` L-20260729-topic-id-title-slug).
 *
 * Every id-minting helper therefore keeps its output inside this budget:
 * `local` (frozen segment below), `createWorkspaceId(randomUUID())` (39 slug
 * chars), and `projectWorkspaceId` (29 — it digests the path precisely so it
 * fits; see `server/project-workspace.ts`). The one legacy shape that exceeds
 * it, `ws:migrated%3A<uuid>` at 50, still retains 34 characters of a v4 UUID
 * after truncation and so cannot collide either.
 */
const DM_SEGMENT_MAX = 48;

/** Slug a provider/workspace segment to the title-id charset (no `~`, no `%`). */
function slugifyDmSegment(part: string): string {
  return part
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, DM_SEGMENT_MAX);
}

/**
 * Deterministic per-(workspace, framework) DM channel id. Pure, no I/O.
 *
 * Every reference to the local workspace — `null`, the retired
 * `workspace:local`/`ws:derived` sentinels, and the new `ws:local` — collapses
 * onto ONE segment, so an existing local DM keeps its exact id (and therefore
 * its history) after the workspace-id migration. Named workspaces slug their
 * own id exactly as before.
 */
export function dmChannelTopicId(
  providerId: string,
  workspaceId: string | null
): string {
  const provider = slugifyDmSegment(providerId) || 'agent';
  const workspace = isLocalWorkspaceRef(workspaceId)
    ? DM_LOCAL_WORKSPACE_SEGMENT
    : slugifyDmSegment(workspaceId ?? '') || DM_LOCAL_WORKSPACE_SEGMENT;
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
  // The id keeps the caller's raw reference (stable across the sentinel
  // retirement); the persisted pointer is the real workspace id.
  return {
    id: dmChannelTopicId(input.providerId, input.workspaceId),
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    title: input.providerDisplayName,
    visibility: 'default',
    routingDefaults: { providerId: input.providerId },
  };
}
