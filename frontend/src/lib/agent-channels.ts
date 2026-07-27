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
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';

export async function getOrCreateDmChannel(input: {
  providerId: string;
  providerDisplayName: string;
  workspaceId: string | null;
}): Promise<WorkspaceTopic> {
  const id = dmChannelTopicId(input.providerId, input.workspaceId);
  try {
    return await fetchWorkspaceTopic(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return createWorkspaceTopic(dmChannelCreateInput(input));
    }
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
