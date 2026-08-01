import {
  createWorkspaceTopic,
  fetchWorkspaceTopic,
  HttpError,
  postChannelMessage,
} from './api.js';
import { dmChannelCreateInput, dmChannelTopicId } from './dm-channels.js';
import { createBrowserId } from './browserId.js';
import { useConfigStore } from './stores/config.js';
import { useToastStore } from './stores/toasts.js';
import { useUiStore } from './stores/ui.js';
import {
  parseWorkspaceTopicConflictDetails,
  type WorkspaceTopic,
} from '../../../shared/workspace-topics.js';

export async function getOrCreateDmChannel(input: {
  providerId: string;
  providerDisplayName: string;
  workspaceId: string | null;
}): Promise<WorkspaceTopic> {
  const id = dmChannelTopicId(input.providerId, input.workspaceId);
  try {
    return await fetchWorkspaceTopic(id);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
  }
  try {
    return await createWorkspaceTopic(dmChannelCreateInput(input));
  } catch (err) {
    // #1287 item 8: a DM id is deterministic, so a 409 here means the row
    // appeared between the 404 read and this write — two surfaces opening the
    // same DM at once. The conflict body names the blocker, so adopt it instead
    // of failing the open; an archived blocker opens onto the channel's own
    // restore bar rather than dead-ending the user.
    const conflict =
      err instanceof HttpError && err.status === 409
        ? parseWorkspaceTopicConflictDetails(err.details)
        : null;
    if (conflict) return await fetchWorkspaceTopic(conflict.blockingTopicId);
    throw err;
  }
}

/** Toast copy when the opening prompt cannot land because the channel is archived. */
export const ARCHIVED_CHANNEL_PROMPT_NOTICE =
  'channel is archived — restore it to send this message';

/**
 * True when a channel post failed ONLY because the channel is archived.
 *
 * Status alone is not proof: the message store answers 409 for
 * `channel_message_seq_conflict`, `parent_channel_mismatch` and
 * `thread_root_channel_mismatch` too (server/channel-message-store.ts), so
 * inferring "archived" from the status replaced a live channel's composer with
 * a restore bar that had nothing to restore. Read the reason code the server
 * already sends.
 */
export function isArchivedChannelPostError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.details?.['reasonCode'] === 'CHANNEL_ARCHIVED'
  );
}

/**
 * Post the opening prompt into a channel the caller has ALREADY opened.
 *
 * #1287 item 8: `getOrCreateDmChannel` can hand back an ARCHIVED row — from the
 * plain read (the common case) or by adopting an archived conflict blocker —
 * and `POST /channels/:id/messages` rejects those with 409 CHANNEL_ARCHIVED.
 * Letting that throw dead-ended the whole launch on a failure toast, against a
 * channel the default sidebar list filters out and the operator therefore
 * cannot reach. Swallow that ONE failure, naming the remedy, so the channel's
 * own restore bar takes over; every other error still throws for the caller.
 */
export async function postOpeningPrompt(
  channelId: string,
  prompt: string
): Promise<'posted' | 'blocked-archived'> {
  try {
    await postChannelMessage(channelId, {
      text: prompt,
      clientMessageId: createBrowserId('chm'),
    });
    return 'posted';
  } catch (error) {
    if (!isArchivedChannelPostError(error)) throw error;
    useToastStore.getState().showToast(ARCHIVED_CHANNEL_PROMPT_NOTICE);
    return 'blocked-archived';
  }
}

export async function openAgentChannel(
  input: {
    providerId?: string;
    workspaceId?: string | null;
    prompt?: string;
  } = {}
): Promise<WorkspaceTopic> {
  const config = useConfigStore.getState();
  const providerId = input.providerId ?? config.defaultAgent;
  const framework = config.frameworks.find((item) => item.id === providerId);
  const ui = useUiStore.getState();
  const topic = await getOrCreateDmChannel({
    providerId,
    providerDisplayName: framework?.displayName ?? providerId,
    workspaceId: input.workspaceId ?? ui.activeWorkspaceId,
  });
  // Open the channel BEFORE posting. The post is the one step that can fail on
  // a channel that already exists and is perfectly reachable (archived rows
  // 409), so ordering the navigation after it made every such failure a dead
  // end instead of a landing on the restore bar this item exists to surface.
  ui.setActiveChannelId(topic.id);
  ui.setTopicComposerOpen(false);
  ui.closeSidebar();
  const prompt = input.prompt?.trim();
  if (prompt) await postOpeningPrompt(topic.id, prompt);
  return topic;
}
