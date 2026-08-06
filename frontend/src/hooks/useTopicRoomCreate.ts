import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  parseWorkspaceTopicConflictDetails,
  type WorkspaceTopicCreateInput,
  type WorkspaceTopicLaunchIntent,
} from '../../../shared/workspace-topics.js';
import {
  createWorkspaceTopic,
  createWorkspaceTopicRoomAndMaybeLaunch,
  fetchHubNodes,
  fetchWorkspaceTopic,
  launchWorkspaceTopicRoom,
  HttpError,
  type WorkspaceTopicLaunchFailure,
  type WorkspaceTopicRoomCreateResult,
} from '../lib/api.js';
import {
  buildTopicRoomCreateInput,
  buildTopicRoomLaunchBody,
  createTopicIdReservation,
  deriveTopicProviderOptions,
  effectiveDraftTitle,
  uniqueStrings,
  TOPIC_ROOM_DRAFT_EMPTY,
  type TopicRoomDraft,
} from '../lib/topic-create.js';
import {
  getOrCreateDmChannel,
  postOpeningPrompt,
} from '../lib/agent-channels.js';
import { taskRefFromDraft } from '../lib/topic-task-ref.js';
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useToastStore } from '../lib/stores/toasts.js';
import { useConfigStore } from '../lib/stores/config.js';
import type { SessionSummary } from '../lib/types.js';

/**
 * #1303: a COMMITTED create spends the lane stamp along with the draft it
 * routed. The store spends it on every composer close, which covers the exits
 * that navigate away (a launch selects the session, the DM path lands on the
 * channel) — but `create only` deliberately leaves the composer standing, and
 * an unspent stamp would silently route the next create in that lane too,
 * including one reached from the command palette with no lane click at all.
 *
 * Deliberately NOT called after the create request returns: a `launch_failed`
 * result keeps the composer open for a retry, and that retry rebuilds its
 * launch body from the live defaults — dropping the stamp there would launch
 * the retry in a different repo than the row that was already created.
 */
function spendLaneRepoRouting(): void {
  useUiStore.getState().setLaneRepoRouting(null);
}

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
  const laneRepoRouting = useUiStore((s) => s.laneRepoRouting);
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
  // #1287 slice 4: the create body carries a client-owned id so a retried or
  // double-submitted POST collides with itself (409, adopt) instead of minting
  // a second channel + WorkContext. Held in a ref, not derived state: it must
  // survive every re-render of one attempt and change only when the attempt
  // does. See `createTopicIdReservation`.
  const topicIdReservation = useRef(createTopicIdReservation());
  const nodesQuery = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    staleTime: 60_000,
  });

  const effectiveTitle = effectiveDraftTitle(draft);
  const taskRef = taskRefFromDraft(draft.taskRef, effectiveTitle);
  const defaultNodeId = activeSession?.nodeId ?? undefined;
  // #1303: a workspace lane the operator explicitly selected outranks EVERY
  // inherited anchor below it. The lane click is the newest statement of where
  // this chat belongs, and the create files the channel in that lane
  // (`activeWorkspaceId`) regardless — so letting a terminal still open in the
  // project the operator just left decide `repoPath`/`cwd` splits one chat
  // across two projects. Ranked ABOVE `activeSession`, not merely above
  // `activeRepoPath`, because that is exactly where the stale session won.
  //
  // Only while the stamp still describes the ACTIVE lane: once the operator
  // moves on, the lane it was about is no longer the one being created in, and
  // the ordinary inheritance chain is the honest answer again.
  const laneRepoPath =
    laneRepoRouting && laneRepoRouting.workspaceId === activeWorkspaceId
      ? laneRepoRouting.repoPath
      : undefined;
  // ...and only where it actually DISAGREES with the session. The lane and the
  // session naming the same repo is the repo's own dogfood shape — a project
  // lane plus a terminal open in `<repo>/.worktrees/<issue-slug>` — and there
  // the session is the strictly better anchor: it knows the worktree, the lane
  // knows only the main checkout. Overriding unconditionally would start the
  // agent in the wrong tree of the RIGHT repo, which is the same class of bug
  // pointed the other way.
  const laneOverridesSession =
    laneRepoPath !== undefined && activeSession?.repoPath !== laneRepoPath;
  const laneAnchor = laneOverridesSession ? laneRepoPath : undefined;
  // Prefer repo/worktree context when it exists, but launch only needs a cwd
  // anchor. Fresh dev/self-host sessions can rely on the backend's local cwd
  // fallback when no repo has been configured yet.
  const defaultRepoPath =
    laneAnchor ??
    activeSession?.repoPath ??
    activeRepoPath ??
    repos[0]?.path ??
    undefined;
  // A worktree and a cwd from the abandoned project are the SAME bug wearing a
  // different field: `buildTopicRoomLaunchBody` copies both, and `cwd` is what
  // the process actually starts in — so a lane-routed create that kept them
  // would claim the new repo and run in the old one. The lane anchor replaces
  // them wholesale; a lane has no worktree of its own to offer. A session
  // inside the lane's own repo keeps both.
  const defaultWorktreePath = laneOverridesSession
    ? undefined
    : (activeSession?.worktreePath ?? undefined);
  const defaultCwd =
    laneAnchor ??
    activeSession?.cwd ??
    defaultWorktreePath ??
    defaultRepoPath ??
    undefined;
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
  const updateDraft = useCallback((patch: Partial<TopicRoomDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setCreatedRoom(null);
    setLaunchFailure(null);
    // An edited draft is a NEW intent, not a retry of the failed one — so it
    // gets its own channel id rather than colliding with the abandoned attempt.
    topicIdReservation.current.release();
  }, []);

  const reset = useCallback(() => {
    setDraft(TOPIC_ROOM_DRAFT_EMPTY);
    setCreatedRoom(null);
    setLaunchFailure(null);
    topicIdReservation.current.release();
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

      // Agent work is channel-native. Get-or-create the deterministic DM,
      // post the first message, and open ChannelView. Agent tasks never create
      // user-visible sessions.
      const willLaunchToChannel =
        intent === 'create-and-launch' && draft.templateKind === 'agent-task';
      if (willLaunchToChannel) {
        setSubmittingIntent('create-and-launch');
        setLaunchFailure(null);
        try {
          const framework = frameworks.find((f) => f.id === selectedProviderId);
          const topic = await getOrCreateDmChannel({
            providerId: selectedProviderId,
            providerDisplayName: framework?.displayName ?? selectedProviderId,
            workspaceId: activeWorkspaceId,
          });
          // #1287 item 8: open the channel BEFORE posting. An archived DM — the
          // plain read hands one back, no race needed — rejects the post with
          // 409 CHANNEL_ARCHIVED, and navigating after the post turned that into
          // a launch-failure dead end against a row the default sidebar filters
          // out. Landing first puts the channel's restore bar on screen whatever
          // the post does; `postOpeningPrompt` toasts the remedy.
          const ui = useUiStore.getState();
          ui.setActiveChannelId(topic.id);
          ui.setTopicComposerOpen(false);
          ui.setForceOrgCockpit(false);
          // #1178: open the channel via the channel path ONLY. Do NOT pass the
          // topic id to onLaunched — in the mounted app that resolves to
          // handleSelectSession → setActiveSessionId, and the channel↔session
          // mutual-exclusion effect would clear the activeChannelId we just set
          // (flash-and-close) and persist a bogus 'topic:...' session key.
          // setActiveChannelId above is sufficient to render ChannelView.
          const prompt = draft.prompt.trim();
          if (prompt) await postOpeningPrompt(topic.id, prompt);
          await queryClient.invalidateQueries({
            queryKey: ['workspace-topics'],
          });
          setDraft(TOPIC_ROOM_DRAFT_EMPTY);
          spendLaneRepoRouting();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          setLaunchFailure({
            stage: 'session',
            message,
            retryable: true,
            ...(error instanceof HttpError && error.code
              ? { code: error.code }
              : {}),
            ...(error instanceof HttpError ? { status: error.status } : {}),
          });
          // The landing above is deliberately ordered BEFORE the post, so by the
          // time the opening post can fail the composer is unmounted and
          // ChannelView owns the screen — `launchFailure` has no surface left to
          // render on. Without this toast a failed opening post was silent: the
          // operator saw an empty channel and no reason. The archived case never
          // reaches here; `postOpeningPrompt` swallows it and names its own
          // remedy.
          useToastStore
            .getState()
            .showToast(`could not start the chat — ${message}`);
        } finally {
          setSubmittingIntent(null);
        }
        return;
      }

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
          spendLaneRepoRouting();
          return;
        }
        const result = await createWorkspaceTopicRoomAndMaybeLaunch({
          room: {
            // Client-owned identity (#1287 slice 4). `previewCreate` stays a
            // pure memo over the draft; the id is reserved here so every retry
            // of THIS attempt reuses it.
            topic: {
              ...previewCreate,
              id: topicIdReservation.current.reserve(),
            },
            ...(taskRef ? { taskRef } : {}),
          },
          ...(submitIntent === 'create-and-launch' && launch
            ? {
                launch,
              }
            : {}),
        });
        // The row is committed (or the blocker adopted), so the reservation is
        // spent — a later create is a new intent and gets a new id. A THROWN
        // create deliberately keeps it: that is the retry the id exists for.
        topicIdReservation.current.release();
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
        spendLaneRepoRouting();
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
      activeWorkspaceId,
      createdRoom,
      draft.prompt,
      draft.templateKind,
      effectiveTitle,
      frameworks,
      previewCreate,
      queryClient,
      selectedProviderId,
      selectLaunchedSession,
      taskRef,
    ]
  );

  /**
   * Create a normal multi-party channel. Unlike agent work, this deliberately
   * carries neither a deterministic DM id nor a provider routing default: the
   * resulting topic is a channel where the operator can invite/mention agents.
   */
  const createChannel = useCallback(
    async (title: string) => {
      const channelTitle = title.trim();
      if (!channelTitle || submittingIntent) return;

      setSubmittingIntent('create-only');
      setLaunchFailure(null);
      const prompt = draft.prompt.trim();
      let navigatedToCreatedChannel = false;
      try {
        const channelRoutingDefaults = {
          ...(previewCreate.routingDefaults?.nodeId
            ? { nodeId: previewCreate.routingDefaults.nodeId }
            : {}),
          ...(previewCreate.routingDefaults?.repoPath
            ? { repoPath: previewCreate.routingDefaults.repoPath }
            : {}),
          ...(previewCreate.routingDefaults?.worktreePath
            ? { worktreePath: previewCreate.routingDefaults.worktreePath }
            : {}),
          ...(previewCreate.routingDefaults?.cwd
            ? { cwd: previewCreate.routingDefaults.cwd }
            : {}),
        };
        const input: WorkspaceTopicCreateInput = {
          id: topicIdReservation.current.reserve(),
          workspaceId: previewCreate.workspaceId,
          title: channelTitle,
          ...(prompt ? { description: prompt.slice(0, 240) } : {}),
          ...(Object.keys(channelRoutingDefaults).length
            ? { routingDefaults: channelRoutingDefaults }
            : {}),
        };
        let topic;
        try {
          topic = await createWorkspaceTopic(input);
        } catch (error) {
          // The opaque id is reserved for this attempt, so a retry after a
          // timeout/double submit may collide with the exact channel it already
          // created. Adopt that normal channel just as topic-room creation does.
          const conflict =
            error instanceof HttpError && error.status === 409
              ? parseWorkspaceTopicConflictDetails(error.details)
              : null;
          if (!conflict) throw error;
          topic = await fetchWorkspaceTopic(conflict.blockingTopicId);
        }
        topicIdReservation.current.release();

        // Navigate before the optional opening post. This makes an archived
        // adopted channel recoverable through ChannelView's restore control,
        // and postOpeningPrompt supplies the established archived-channel toast.
        const ui = useUiStore.getState();
        ui.setActiveChannelId(topic.id);
        navigatedToCreatedChannel = true;
        ui.setTopicComposerOpen(false);
        ui.setForceOrgCockpit(false);
        try {
          await queryClient.invalidateQueries({
            queryKey: ['workspace-topics'],
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          useToastStore
            .getState()
            .showToast(
              `channel created, but sidebar refresh failed — ${message}`
            );
        }
        setDraft(TOPIC_ROOM_DRAFT_EMPTY);
        spendLaneRepoRouting();
        if (!prompt) return;
        try {
          await postOpeningPrompt(topic.id, prompt);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          useToastStore
            .getState()
            .showToast(
              `channel created, but opening message failed — ${message}`
            );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLaunchFailure({
          stage: 'topic',
          message,
          retryable: true,
          ...(error instanceof HttpError && error.code
            ? { code: error.code }
            : {}),
          ...(error instanceof HttpError ? { status: error.status } : {}),
        });
        // Only an error after this attempt landed on its new channel needs a
        // toast: the Composer is gone. An existing channel must not turn an
        // inline create failure into a misleading duplicate toast.
        if (navigatedToCreatedChannel) {
          useToastStore
            .getState()
            .showToast(`could not create channel — ${message}`);
        }
      } finally {
        setSubmittingIntent(null);
      }
    },
    [
      draft.prompt,
      previewCreate.routingDefaults?.cwd,
      previewCreate.routingDefaults?.nodeId,
      previewCreate.routingDefaults?.repoPath,
      previewCreate.routingDefaults?.worktreePath,
      previewCreate.workspaceId,
      queryClient,
      submittingIntent,
    ]
  );

  return {
    draft,
    updateDraft,
    reset,
    submit,
    createChannel,
    submittingIntent,
    launchFailure,
    effectiveTitle,
    previewCreate,
    nodes,
    providerOptions,
    selectedProviderId,
    selectedProviderOption,
    nodeOptions,
    repoPathOptions,
    worktreePathOptions,
    cwdOptions,
  };
}
