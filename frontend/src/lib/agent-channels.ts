import {
  createWorkspaceTopic,
  fetchWorkspaceTopic,
  HttpError,
  postChannelMessage,
} from './api.js';
import { dmChannelCreateInput, dmChannelTopicId } from './dm-channels.js';
import { createBrowserId } from './browserId.js';
import { useConfigStore } from './stores/config.js';
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
  const prompt = input.prompt?.trim();
  if (prompt) {
    await postChannelMessage(topic.id, {
      text: prompt,
      clientMessageId: createBrowserId('chm'),
    });
  }
  ui.setActiveChannelId(topic.id);
  ui.setTopicComposerOpen(false);
  ui.closeSidebar();
  return topic;
}
