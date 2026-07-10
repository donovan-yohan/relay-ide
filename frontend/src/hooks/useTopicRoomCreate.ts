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
  deriveTopicProviderLaunchMode,
  deriveTopicProviderOptions,
  effectiveDraftTitle,
  uniqueStrings,
  TOPIC_ROOM_DRAFT_EMPTY,
  type TopicRoomDraft,
} from '../lib/topic-create.js';
import { taskRefFromDraft } from '../lib/topic-task-ref.js';
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useToastStore } from '../lib/stores/toasts.js';
import { useConfigStore } from '../lib/stores/config.js';
import type { SessionSummary } from '../lib/types.js';

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
  const repos = useSessionsStore((s) => s.repos);
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
  const defaultNodeId = activeSession?.nodeId ?? undefined;
  // Prefer repo/worktree context when it exists, but launch only needs a cwd
  // anchor. Fresh dev/self-host sessions can rely on the backend's local cwd
  // fallback when no repo has been configured yet.
  const defaultRepoPath =
    activeSession?.repoPath ?? activeRepoPath ?? repos[0]?.path ?? undefined;
  const defaultWorktreePath = activeSession?.worktreePath ?? undefined;
  const defaultCwd =
    activeSession?.cwd ?? defaultWorktreePath ?? defaultRepoPath ?? undefined;
  const selectedProviderId = draft.providerId.trim() || defaultAgent;
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
      deriveTopicProviderOptions({
        frameworks,
        defaultProviderId: defaultAgent,
        selectedProviderId,
        templateKind: draft.templateKind,
      }),
    [defaultAgent, draft.templateKind, frameworks, selectedProviderId]
  );
  const selectedProviderOption = useMemo(
    () =>
      providerOptions.find((option) => option.id === selectedProviderId) ??
      providerOptions[0],
    [providerOptions, selectedProviderId]
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
        defaultNodeId,
        defaultRepoPath,
        defaultWorktreePath,
        defaultCwd,
        taskRef,
      }),
    [
      defaultNodeId,
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
  const launchMode = useMemo(
    () =>
      deriveTopicProviderLaunchMode(
        previewCreate.routingDefaults?.providerId ?? defaultAgent,
        draft.templateKind,
        frameworks
      ),
    [
      defaultAgent,
      draft.templateKind,
      frameworks,
      previewCreate.routingDefaults,
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

  const selectLaunchedSession = useCallback(
    async (session: SessionSummary) => {
      await useSessionsStore.getState().refreshAll();
      const sessionsState = useSessionsStore.getState();
      const launchedKey = scopedSessionKey(session);
      const refreshedSession =
        resolveSessionByKey(sessionsState.sessions, launchedKey) ??
        resolveSessionByKey(sessionsState.sessions, session.id);
      if (!refreshedSession) {
        useSessionsStore.setState((state) => {
          const alreadyPresent =
            resolveSessionByKey(state.sessions, launchedKey) ??
            resolveSessionByKey(state.sessions, session.id);
          if (alreadyPresent) return {};
          return { sessions: [session, ...state.sessions] };
        });
      }
      const selectedSession = refreshedSession ?? session;
      const selectedKey = scopedSessionKey(selectedSession);
      const ui = useUiStore.getState();

      // #1123: topic launches are chat-first even when they inherit repo
      // routing defaults. Keep the workspace recall map warm, but do not bind
      // the primary route to the repo dashboard; the cockpit remains an
      // explicit escape hatch.
      if (selectedSession.repoPath) {
        sessionsState.rememberSessionForWorkspace(
          selectedSession.repoPath,
          selectedKey
        );
      }
      ui.setActiveRepoPath(null);

      setActiveSessionId(selectedKey);
      ui.setForceOrgCockpit(false);
      ui.setTopicComposerOpen(false);
      onLaunched?.(selectedKey);
      // App-level launch handlers historically select the session and restore
      // its repo route. Re-assert chat-first routing after those sync handlers
      // run so start/resume cannot bounce into dashboard chrome.
      useUiStore.getState().setActiveRepoPath(null);
      useUiStore.getState().setForceOrgCockpit(false);
    },
    [onLaunched, setActiveSessionId]
  );

  const submit = useCallback(
    async (intent: WorkspaceTopicLaunchIntent) => {
      if (!effectiveTitle) return;
      const launch = buildTopicRoomLaunchBody(
        previewCreate,
        draft.templateKind,
        frameworks
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
          await selectLaunchedSession(result.session);
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
          await selectLaunchedSession(result.session);
        } else {
          // create-only success has no navigation — confirm it happened and
          // surface where the new room lives.
          useToastStore
            .getState()
            .showToast('topic room created — find it in the sidebar', 'info');
          useUiStore.getState().openSidebar();
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
      frameworks,
      previewCreate,
      queryClient,
      selectLaunchedSession,
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
    selectedProviderId,
    selectedProviderOption,
    launchMode,
    nodeOptions,
    repoPathOptions,
    worktreePathOptions,
    cwdOptions,
  };
}
