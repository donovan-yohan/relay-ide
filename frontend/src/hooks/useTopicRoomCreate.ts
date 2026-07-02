import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WorkspaceTopicCreateInput,
  WorkspaceTopicLaunchIntent,
} from '../../../shared/workspace-topics.js';
import {
  createWorkspaceTopicRoomAndMaybeLaunch,
  fetchHubNodes,
  launchWorkspaceTopicRoom,
  type WorkspaceTopicLaunchFailure,
  type WorkspaceTopicRoomCreateResult,
} from '../lib/api.js';
import {
  buildTopicRoomCreateInput,
  buildTopicRoomLaunchBody,
  effectiveDraftTitle,
  uniqueStrings,
  FALLBACK_PROVIDER_IDS,
  TOPIC_ROOM_DRAFT_EMPTY,
  type TopicRoomDraft,
} from '../lib/topic-create.js';
import { taskRefFromDraft } from '../lib/topic-task-ref.js';
import { resolveSessionByKey } from '../lib/session-keys.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';

/**
 * #1058: stateful draft + create/launch plumbing for codex-style topic
 * creation. Owns the draft, resolves workspace defaults (provider, node,
 * repo, worktree, cwd) from the active context, and drives the two-step
 * create → launch flow with retry-after-launch-failure support.
 */
export function useTopicRoomCreate({
  onLaunched,
}: {
  onLaunched?: ((sessionId: string) => void) | undefined;
} = {}) {
  const queryClient = useQueryClient();
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionsStore((s) => s.setActiveSessionId);
  const activeRepoPath = useUiStore((s) => s.activeRepoPath);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const defaultAgent = useConfigStore((s) => s.defaultAgent);
  const frameworks = useConfigStore((s) => s.frameworks);
  const activeSession = useMemo(
    () => resolveSessionByKey(sessions, activeSessionId),
    [activeSessionId, sessions]
  );
  const [draft, setDraft] = useState<TopicRoomDraft>(TOPIC_ROOM_DRAFT_EMPTY);
  const [submittingIntent, setSubmittingIntent] =
    useState<WorkspaceTopicLaunchIntent | null>(null);
  const [launchFailure, setLaunchFailure] =
    useState<WorkspaceTopicLaunchFailure | null>(null);
  const [createdRoom, setCreatedRoom] =
    useState<WorkspaceTopicRoomCreateResult | null>(null);
  const nodesQuery = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    staleTime: 60_000,
  });

  const effectiveTitle = effectiveDraftTitle(draft);
  const taskRef = taskRefFromDraft(draft.taskRef, effectiveTitle);
  const defaultRepoPath =
    activeSession?.repoPath ?? activeRepoPath ?? undefined;
  const defaultWorktreePath = activeSession?.worktreePath ?? undefined;
  const defaultCwd =
    activeSession?.cwd ?? defaultWorktreePath ?? defaultRepoPath ?? undefined;
  const nodes = useMemo(
    () =>
      (nodesQuery.data ?? []).map((node) => ({
        nodeId: node.nodeId,
        displayName: node.displayName,
      })),
    [nodesQuery.data]
  );
  const providerOptions = useMemo(
    () =>
      uniqueStrings([
        defaultAgent,
        ...frameworks.map((framework) => framework.id),
        ...FALLBACK_PROVIDER_IDS,
      ]),
    [defaultAgent, frameworks]
  );
  const nodeOptions = useMemo(
    () =>
      (nodesQuery.data ?? []).map((node) => ({
        value: node.nodeId,
        label: node.displayName
          ? `${node.displayName} · ${node.status}`
          : node.status,
      })),
    [nodesQuery.data]
  );
  const repoPathOptions = useMemo(
    () =>
      uniqueStrings([
        defaultRepoPath,
        ...sessions.map((session) => session.repoPath),
      ]),
    [defaultRepoPath, sessions]
  );
  const worktreePathOptions = useMemo(
    () =>
      uniqueStrings([
        defaultWorktreePath,
        ...sessions.map((session) => session.worktreePath),
      ]),
    [defaultWorktreePath, sessions]
  );
  const cwdOptions = useMemo(
    () =>
      uniqueStrings([defaultCwd, ...sessions.map((session) => session.cwd)]),
    [defaultCwd, sessions]
  );
  const previewCreate = useMemo<WorkspaceTopicCreateInput>(
    () =>
      buildTopicRoomCreateInput({
        draft: { ...draft, title: effectiveTitle },
        workspaceId: activeWorkspaceId,
        defaultProviderId: defaultAgent,
        defaultNodeId: activeSession?.nodeId,
        defaultRepoPath,
        defaultWorktreePath,
        defaultCwd,
        taskRef,
      }),
    [
      activeSession?.nodeId,
      activeWorkspaceId,
      draft,
      defaultAgent,
      defaultCwd,
      defaultRepoPath,
      defaultWorktreePath,
      effectiveTitle,
      taskRef,
    ]
  );

  const updateDraft = useCallback((patch: Partial<TopicRoomDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setCreatedRoom(null);
    setLaunchFailure(null);
  }, []);

  const reset = useCallback(() => {
    setDraft(TOPIC_ROOM_DRAFT_EMPTY);
    setCreatedRoom(null);
    setLaunchFailure(null);
  }, []);

  const submit = useCallback(
    async (intent: WorkspaceTopicLaunchIntent) => {
      if (!effectiveTitle) return;
      const launch = buildTopicRoomLaunchBody(
        previewCreate,
        draft.templateKind
      );
      const submitIntent =
        intent === 'create-and-launch' && launch
          ? 'create-and-launch'
          : 'create-only';
      setSubmittingIntent(submitIntent);
      setLaunchFailure(null);
      try {
        if (submitIntent === 'create-and-launch' && createdRoom && launch) {
          const result = await launchWorkspaceTopicRoom({
            room: createdRoom,
            launch,
          });
          if (result.status === 'launch_failed') {
            setLaunchFailure(result.failure);
            return;
          }
          await useSessionsStore.getState().refreshAll();
          setActiveSessionId(result.session.id);
          onLaunched?.(result.session.id);
          setCreatedRoom(null);
          setDraft(TOPIC_ROOM_DRAFT_EMPTY);
          return;
        }
        const result = await createWorkspaceTopicRoomAndMaybeLaunch({
          room: {
            topic: previewCreate,
            ...(taskRef ? { taskRef } : {}),
          },
          ...(submitIntent === 'create-and-launch' && launch
            ? {
                launch,
              }
            : {}),
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['workspace-topics'] }),
          queryClient.invalidateQueries({ queryKey: ['workspace-surfaces'] }),
        ]);
        if (result.status === 'launch_failed') {
          setLaunchFailure(result.failure);
          setCreatedRoom({
            topic: result.topic,
            workContext: result.workContext,
          });
          return;
        }
        if (result.status === 'launched') {
          await useSessionsStore.getState().refreshAll();
          setActiveSessionId(result.session.id);
          onLaunched?.(result.session.id);
        }
        setCreatedRoom(null);
        setDraft(TOPIC_ROOM_DRAFT_EMPTY);
      } catch (error) {
        const failure = error as WorkspaceTopicLaunchFailure;
        setLaunchFailure({
          stage: failure.stage ?? 'topic',
          message:
            typeof failure.message === 'string'
              ? failure.message
              : error instanceof Error
                ? error.message
                : String(error),
          retryable: failure.retryable ?? false,
          ...(failure.code ? { code: failure.code } : {}),
          ...(failure.status ? { status: failure.status } : {}),
        });
      } finally {
        setSubmittingIntent(null);
      }
    },
    [
      createdRoom,
      draft.templateKind,
      effectiveTitle,
      onLaunched,
      previewCreate,
      queryClient,
      setActiveSessionId,
      taskRef,
    ]
  );

  return {
    draft,
    updateDraft,
    reset,
    submit,
    submittingIntent,
    launchFailure,
    effectiveTitle,
    previewCreate,
    nodes,
    providerOptions,
    nodeOptions,
    repoPathOptions,
    worktreePathOptions,
    cwdOptions,
  };
}
