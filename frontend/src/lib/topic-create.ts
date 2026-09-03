import {
  mintWorkspaceTopicId,
  type WorkspaceTopicCreateInput,
  type WorkspaceTopicId,
  type WorkspaceTopicLaunchIntent,
  type WorkspaceTopicTemplateKind,
} from '../../../shared/workspace-topics.js';
import type { CreateSessionBody, WorkspaceTopicLaunchFailure } from './api.js';
import { isFrameworkAvailable } from './framework-availability.js';
import type { FrameworkInfo } from './types.js';
import type { taskRefFromDraft } from './topic-task-ref.js';
import { normalizeWorkspaceId } from '../../../shared/workspace.js';

/**
 * #1058: pure draft/build helpers for codex-style topic creation, shared by
 * the main-pane TopicComposer (primary path) and any future create surfaces.
 * The first message doubles as the room title unless the operator overrides
 * it in the advanced section.
 */
export type TopicRoomDraft = {
  title: string;
  prompt: string;
  taskRef: string;
  providerId: string;
  agentId: string;
  nodeId: string;
  repoPath: string;
  worktreePath: string;
  cwd: string;
  templateKind: WorkspaceTopicTemplateKind;
};

export const TOPIC_ROOM_DRAFT_EMPTY: TopicRoomDraft = {
  title: '',
  prompt: '',
  taskRef: '',
  providerId: '',
  agentId: '',
  nodeId: '',
  repoPath: '',
  worktreePath: '',
  cwd: '',
  templateKind: 'agent-task',
};

export const TOPIC_ROOM_TEMPLATE_OPTIONS: Array<{
  value: WorkspaceTopicTemplateKind;
  label: string;
}> = [
  { value: 'agent-task', label: 'agent task' },
  { value: 'terminal-task', label: 'terminal task' },
  { value: 'note', label: 'note / room only' },
];

export const FALLBACK_PROVIDER_IDS = [
  'claude',
  'codex',
  'opencode',
  'hermes',
  'prime-agent',
  'pi',
  'antigravity',
  'dsh',
  'cursor',
];

export type TopicProviderOption = {
  id: string;
  label: string;
  status: string;
  disabled: boolean;
  isDefault: boolean;
  reason?: string;
};

export function compactString(
  value: string | null | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function uniqueStrings(
  values: Array<string | null | undefined>
): string[] {
  return Array.from(
    new Set(values.map((value) => compactString(value)).filter(Boolean))
  ) as string[];
}

export function deriveTopicTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0] ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  // Code-point-aware truncation so a trailing emoji is not split in half.
  const points = Array.from(collapsed);
  return points.length > 60 ? `${points.slice(0, 59).join('')}…` : collapsed;
}

/** Title used for create/launch: explicit override wins, else the message. */
export function effectiveDraftTitle(
  draft: Pick<TopicRoomDraft, 'title' | 'prompt'>
) {
  return draft.title.trim() || deriveTopicTitleFromPrompt(draft.prompt);
}

export function launchSubmitLabel(input: {
  submittingIntent?: WorkspaceTopicLaunchIntent | null | undefined;
  launchDisabled: boolean;
  launchFailure?: WorkspaceTopicLaunchFailure | null | undefined;
}): string {
  if (input.submittingIntent === 'create-and-launch') return 'starting…';
  if (input.submittingIntent === 'create-only') return 'creating…';
  if (input.launchDisabled) return 'create chat';
  if (!input.launchFailure) return 'start chat';
  return input.launchFailure.stage === 'session'
    ? 'retry start'
    : 'retry create + start';
}

export function launchTypeForTemplate(
  templateKind: WorkspaceTopicTemplateKind
): CreateSessionBody['type'] | null {
  if (templateKind === 'terminal-task') return 'terminal';
  return null;
}

function frameworkForProvider(
  frameworks: FrameworkInfo[],
  providerId: string
): FrameworkInfo | undefined {
  return frameworks.find((framework) => framework.id === providerId);
}

function frameworkDisplayName(
  frameworks: FrameworkInfo[],
  providerId: string
): string {
  return (
    frameworkForProvider(frameworks, providerId)?.displayName ?? providerId
  );
}

export function topicProviderStatus(input: {
  option: Pick<TopicProviderOption, 'isDefault' | 'disabled' | 'reason'>;
  templateKind: WorkspaceTopicTemplateKind;
}): string {
  const prefix = input.option.isDefault ? 'global default' : 'one-off override';
  if (input.option.disabled) {
    return `${prefix} · unavailable${input.option.reason ? `: ${input.option.reason}` : ''}`;
  }
  const destination =
    input.templateKind === 'agent-task'
      ? 'chat'
      : input.templateKind === 'terminal-task'
        ? 'terminal'
        : 'room';
  return `${prefix} · ${destination}`;
}

export function deriveTopicProviderOptions(input: {
  frameworks: FrameworkInfo[];
  defaultProviderId: string;
  selectedProviderId?: string | undefined;
  templateKind: WorkspaceTopicTemplateKind;
}): TopicProviderOption[] {
  const providerIds = uniqueStrings([
    input.selectedProviderId,
    input.defaultProviderId,
    ...input.frameworks.map((framework) => framework.id),
    ...FALLBACK_PROVIDER_IDS,
  ]);
  return providerIds.map((providerId) => {
    const framework = frameworkForProvider(input.frameworks, providerId);
    const installed = framework ? isFrameworkAvailable(framework) : true;
    const missingReason = installed
      ? undefined
      : (framework?.availability?.reason ??
        `${providerId} CLI not found on PATH`);
    const option: TopicProviderOption = {
      id: providerId,
      label: frameworkDisplayName(input.frameworks, providerId),
      disabled: !installed,
      isDefault: providerId === input.defaultProviderId,
      ...(missingReason ? { reason: missingReason } : {}),
      status: '',
    };
    return {
      ...option,
      status: topicProviderStatus({
        option,
        templateKind: input.templateKind,
      }),
    };
  });
}

export function buildTopicRoomLaunchBody(
  create: WorkspaceTopicCreateInput,
  templateKind: WorkspaceTopicTemplateKind,
  _frameworks: FrameworkInfo[] = []
): Omit<CreateSessionBody, 'workspaceTopicId' | 'workContextId'> | null {
  const type = launchTypeForTemplate(templateKind);
  if (!type) return null;
  const routing = create.routingDefaults ?? {};
  return {
    type,
    mode: 'pty',
    ...(routing.nodeId ? { nodeId: routing.nodeId } : {}),
    ...(routing.repoPath ? { repoPath: routing.repoPath } : {}),
    ...(routing.worktreePath ? { worktreePath: routing.worktreePath } : {}),
    ...(routing.cwd ? { cwd: routing.cwd } : {}),
  };
}

/**
 * A client-owned id reservation for ONE create attempt (#1287 slice 4).
 *
 * The title used to be the id, which made `POST /workspace-topics` accidentally
 * idempotent: a retried or double-submitted create 409'd as a no-op. Opaque ids
 * removed that guard, and nothing else replaced it — every retry would mint a
 * fresh row AND a fresh WorkContext. That is not merely untidy: the topic store
 * caps at `WORKSPACE_TOPICS_MAX_STORED_ENTRIES` rows and reacts to the cap by
 * DELETING the oldest archived topics, whose `channel_messages` the boot orphan
 * sweep then erases — so an unguarded retry loop shreds archived transcripts.
 *
 * So the client mints the id ONCE per attempt and reuses it for every retry of
 * that attempt: the second POST lands on the self-explaining 409 and adopts the
 * blocker instead of forking a second channel. `release()` ends the attempt —
 * a committed create, a reset, or an edited draft (a genuinely new intent).
 *
 * Deliberately a closure rather than a mint inside `buildTopicRoomCreateInput`:
 * that builder is memoized over the draft, so minting there would hand out a
 * new id on every re-render and defeat the idempotence it is meant to provide.
 */
export function createTopicIdReservation(
  mint: () => WorkspaceTopicId = mintWorkspaceTopicId
): { reserve(): WorkspaceTopicId; release(): void } {
  let reserved: WorkspaceTopicId | null = null;
  return {
    reserve() {
      reserved ??= mint();
      return reserved;
    },
    release() {
      reserved = null;
    },
  };
}

export function buildTopicRoomCreateInput(input: {
  draft: TopicRoomDraft;
  workspaceId: string | null;
  defaultProviderId: string;
  defaultNodeId?: string | undefined;
  defaultRepoPath?: string | undefined;
  defaultWorktreePath?: string | undefined;
  defaultCwd?: string | undefined;
  taskRef: ReturnType<typeof taskRefFromDraft>;
}): WorkspaceTopicCreateInput {
  const providerId =
    compactString(input.draft.providerId) ?? input.defaultProviderId;
  const agentId = compactString(input.draft.agentId);
  const nodeId = compactString(input.draft.nodeId) ?? input.defaultNodeId;
  const repoPath = compactString(input.draft.repoPath) ?? input.defaultRepoPath;
  const worktreePath =
    compactString(input.draft.worktreePath) ?? input.defaultWorktreePath;
  const cwd = compactString(input.draft.cwd) ?? input.defaultCwd;
  const prompt = input.draft.prompt.trim();

  return {
    // #1287 slice 2: resolve the active IA workspace, falling back to the
    // hub-seeded local workspace. Never the old `workspace:local` sentinel —
    // that string can never equal an `ia_workspaces` id, so every channel it
    // stamped landed in the sidebar's orphan lane.
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    title: input.draft.title.trim() || 'Untitled chat',
    ...(prompt ? { description: prompt.slice(0, 240) } : {}),
    promptDefaults: {
      ...(prompt ? { starterPrompt: prompt } : {}),
    },
    routingDefaults: {
      ...(providerId ? { providerId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(repoPath ? { repoPath } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(cwd ? { cwd } : {}),
    },
    linkedRefs: {
      ...(input.taskRef ? { taskRefs: [input.taskRef] } : {}),
    },
  };
}
