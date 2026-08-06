import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  buildWorkspaceTopicLaunchPreview,
  type WorkspaceTopicTemplateKind,
} from '../../../shared/workspace-topics.js';
import { useTopicRoomCreate } from '../hooks/useTopicRoomCreate.js';
import { useIaWorkspacesQuery } from '../lib/hooks/use-ia-workspaces.js';
import type { IaWorkspace } from '../lib/api.js';
import {
  launchSubmitLabel,
  launchTypeForTemplate,
  deriveTopicTitleFromPrompt,
  TOPIC_ROOM_TEMPLATE_OPTIONS,
  type TopicProviderOption,
} from '../lib/topic-create.js';
import { TOPIC_COMPOSER_FOCUS_EVENT } from '../lib/topic-task-room.js';
import { applyWorkspaceCreateRoutingContext } from '../lib/topic-selection.js';
import { useUiStore } from '../lib/stores/ui.js';
import { isMobileDevice } from '../lib/utils.js';
import TuiButton from './TuiButton.js';
import './TopicComposer.css';

function TopicComposerProviderRow({
  providerOptions,
  selectedProviderId,
  selectedProviderOption,
  providerUnavailable,
  onProviderChange,
}: {
  providerOptions: TopicProviderOption[];
  selectedProviderId: string;
  selectedProviderOption?: TopicProviderOption | undefined;
  providerUnavailable: boolean;
  onProviderChange: (providerId: string) => void;
}) {
  const providerSelectId = useId();
  const providerStatusId = useId();

  return (
    <div className="topic-composer__provider-row">
      <label
        className="topic-composer__provider-label"
        htmlFor={providerSelectId}
      >
        coding agent
      </label>
      <select
        className="topic-composer__provider-select"
        id={providerSelectId}
        value={selectedProviderId}
        onChange={(event) => onProviderChange(event.currentTarget.value)}
        aria-describedby={providerStatusId}
      >
        {providerOptions.map((option) => (
          <option
            key={option.id}
            value={option.id}
            disabled={option.disabled && option.id !== selectedProviderId}
          >
            {option.label}
            {option.isDefault ? ' (default)' : ''}
            {option.disabled ? ' (unavailable)' : ''}
          </option>
        ))}
      </select>
      <span
        className={
          providerUnavailable
            ? 'topic-composer__provider-status topic-composer__provider-status--error'
            : 'topic-composer__provider-status'
        }
        id={providerStatusId}
      >
        {selectedProviderOption?.status ?? 'global default · tui launch'}
      </span>
    </div>
  );
}

/** Project selection stays outside the composer body so the creation flow can
 * focus on chat type and submission, while this control owns its async states. */
function TopicComposerProjectSelector({
  workspaces,
  selectedWorkspace,
  loading,
  error,
}: {
  workspaces: IaWorkspace[];
  selectedWorkspace: IaWorkspace | undefined;
  loading: boolean;
  error: boolean;
}) {
  return (
    <label className="topic-composer__project">
      <span>project</span>
      <select
        aria-label="project"
        value={selectedWorkspace?.id ?? ''}
        disabled={loading || error}
        onChange={(event) => {
          const workspace = workspaces.find(
            (candidate) => candidate.id === event.currentTarget.value
          );
          if (!workspace) return;
          applyWorkspaceCreateRoutingContext({
            workspaceId: workspace.id,
            defaultRepoPath: workspace.defaultRepoPath,
            defaultNodeId: workspace.defaultNodeId,
          });
        }}
      >
        <option value="">
          {loading
            ? 'loading projects…'
            : error
              ? 'projects unavailable'
              : 'choose a project'}
        </option>
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
      {error ? (
        <span className="topic-composer__project-status" role="alert">
          could not load projects
        </span>
      ) : !loading && !selectedWorkspace ? (
        <span className="topic-composer__project-status">
          choose a project before creating a chat
        </span>
      ) : null}
    </label>
  );
}

function primaryIntentForTemplate(templateKind: WorkspaceTopicTemplateKind) {
  return templateKind === 'note' ? 'create-only' : 'create-and-launch';
}

type ComposerDestination = 'direct-message' | 'channel';

function composerSubmitDisabled(input: {
  effectiveTitle: string;
  submitting: boolean;
  launchProviderUnavailable: boolean;
}) {
  return (
    !input.effectiveTitle || input.submitting || input.launchProviderUnavailable
  );
}

function friendlyTopicNodeLabel(input: {
  routedNodeId?: string | undefined;
  nodes: Array<{ nodeId: string; displayName?: string | undefined }>;
  fallbackLabel: string;
}) {
  if (!input.routedNodeId) return input.fallbackLabel;
  return (
    input.nodes.find((node) => node.nodeId === input.routedNodeId)
      ?.displayName || 'remote node'
  );
}

/**
 * #1058: the codex-style primary entry point. Lives in the main pane (not the
 * sidebar): a single message box centered in the open space — type the first
 * prompt, hit start, and the topic + session exist with that message. All
 * routing metadata (provider/agent/node/repo/worktree/cwd/task ref) stays
 * available behind the advanced disclosure and keeps flowing into
 * routingDefaults for agent-to-agent use.
 */
export default function TopicComposer({
  onSelectSession,
  resume,
}: {
  onSelectSession?: ((id: string) => void) | undefined;
  resume?: { label: string; onResume: () => void } | undefined;
}) {
  const setTopicComposerOpen = useUiStore((s) => s.setTopicComposerOpen);
  const activeWorkspaceId = useUiStore((s) => s.activeWorkspaceId);
  const projectCreateRouting = useUiStore((s) => s.projectCreateRouting);
  const workspacesQuery = useIaWorkspacesQuery();
  const workspaces = workspacesQuery.data ?? [];
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId),
    [activeWorkspaceId, workspaces]
  );
  const {
    draft,
    updateDraft,
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
  } = useTopicRoomCreate({
    onLaunched: onSelectSession,
    // A project selected here (or the sidebar's project-scoped add button)
    // leaves a one-use routing stamp. Only that explicit choice outranks an
    // inherited session; merely remembering an active project preserves the
    // established lane/session fallback.
    workspace:
      selectedWorkspace &&
      projectCreateRouting?.workspaceId === selectedWorkspace.id
        ? {
            id: selectedWorkspace.id,
            defaultRepoPath: projectCreateRouting.repoPath,
            defaultNodeId: projectCreateRouting.nodeId,
          }
        : undefined,
  });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [destination, setDestination] =
    useState<ComposerDestination>('direct-message');
  const [channelName, setChannelName] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // #1058: focus on mount (desktop only — see the isMobileDevice guard).
  // Uses an imperative `.focus({ preventScroll: true })` instead of the JSX
  // `autoFocus` attribute: `autoFocus`'s default scroll-into-view behavior
  // scrolls the *page*, not just the textarea into view, which on a landing
  // with a live-sessions list taller than the viewport yanks the whole
  // scroll position down to the composer — pushing every session row
  // offscreen before the user (or a test driving `.click()`) can reach them.
  useEffect(() => {
    if (!isMobileDevice) taRef.current?.focus({ preventScroll: true });
  }, []);

  // Focus request from openTopicTaskRoom() — covers the already-on-landing
  // case where the component does not remount so the mount-time focus effect
  // never re-fires. Same preventScroll rationale as above.
  useEffect(() => {
    const focus = () => taRef.current?.focus({ preventScroll: true });
    window.addEventListener(TOPIC_COMPOSER_FOCUS_EVENT, focus);
    return () => window.removeEventListener(TOPIC_COMPOSER_FOCUS_EVENT, focus);
  }, []);

  const preview = useMemo(
    () =>
      buildWorkspaceTopicLaunchPreview({
        create: previewCreate,
        intent:
          draft.templateKind === 'note' ? 'create-only' : 'create-and-launch',
        templateKind: draft.templateKind,
        launchOverrides: {
          ...(launchTypeForTemplate(draft.templateKind)
            ? { type: 'terminal' as const }
            : {}),
          mode: 'pty',
          nodeId: previewCreate.routingDefaults?.nodeId,
          repoPath: previewCreate.routingDefaults?.repoPath,
          worktreePath: previewCreate.routingDefaults?.worktreePath,
          cwd: previewCreate.routingDefaults?.cwd,
        },
      }),
    [draft.templateKind, previewCreate]
  );
  const launchDisabled = draft.templateKind === 'note';
  // Notes are rooms without a session — the primary action degrades to
  // create-only instead of dead-ending the keyboard.
  const primaryIntent = primaryIntentForTemplate(draft.templateKind);
  const providerUnavailable = Boolean(selectedProviderOption?.disabled);
  const createOnlyDisabled = !effectiveTitle || Boolean(submittingIntent);
  const disabled = composerSubmitDisabled({
    effectiveTitle,
    submitting: Boolean(submittingIntent),
    launchProviderUnavailable:
      primaryIntent === 'create-and-launch' && providerUnavailable,
  });
  const creatingChannel = destination === 'channel';
  const channelDisabled = !channelName.trim() || Boolean(submittingIntent);
  // A channel (including deterministic direct messages) belongs to a real
  // project. Do not submit against an old synthetic/stale workspace id while
  // the authoritative project list is unavailable or does not contain it.
  const projectUnavailable =
    workspacesQuery.isLoading || workspacesQuery.isError || !selectedWorkspace;
  const submitDisabled =
    (creatingChannel ? channelDisabled : disabled) || projectUnavailable;
  // #1103: never render a raw node id — resolve through the roster or fall
  // back to a generic label.
  const routedNodeId = previewCreate.routingDefaults?.nodeId;
  const friendlyNodeLabel = friendlyTopicNodeLabel({
    routedNodeId,
    nodes,
    fallbackLabel: preview.nodeLabel,
  });

  return (
    <div className="topic-composer">
      <div className="topic-composer__panel">
        <span className="topic-composer__title">new chat</span>
        <form
          className="topic-composer__form"
          aria-label="new chat"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!submitDisabled) {
              if (creatingChannel) void createChannel(channelName);
              else void submit(primaryIntent);
            }
          }}
        >
          <div
            className="topic-composer__destination"
            role="group"
            aria-label="chat type"
          >
            <button
              type="button"
              aria-pressed={destination === 'direct-message'}
              className={
                destination === 'direct-message' ? 'is-selected' : undefined
              }
              onClick={() => setDestination('direct-message')}
            >
              direct message
            </button>
            <button
              type="button"
              aria-pressed={creatingChannel}
              className={creatingChannel ? 'is-selected' : undefined}
              onClick={() => {
                setDestination('channel');
                setAdvancedOpen(false);
              }}
            >
              channel
            </button>
          </div>
          <TopicComposerProjectSelector
            workspaces={workspaces}
            selectedWorkspace={selectedWorkspace}
            loading={workspacesQuery.isLoading}
            error={workspacesQuery.isError}
          />
          {creatingChannel ? (
            <label className="topic-composer__channel-name">
              <span>channel name</span>
              <input
                value={channelName}
                onChange={(event) => setChannelName(event.target.value)}
                placeholder="e.g. release coordination"
                aria-label="channel name"
                autoComplete="off"
              />
            </label>
          ) : null}
          <textarea
            ref={taRef}
            className="topic-composer__ta"
            value={draft.prompt}
            onChange={(event) => updateDraft({ prompt: event.target.value })}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !submitDisabled
              ) {
                event.preventDefault();
                if (creatingChannel) void createChannel(channelName);
                else void submit(primaryIntent);
              } else if (event.key === 'Escape') {
                // Composer opened over an active session — Escape returns to
                // it. No-op on the bare landing (flag already false).
                setTopicComposerOpen(false);
              }
            }}
            placeholder={
              creatingChannel
                ? 'optional opening message'
                : 'what should the agent do?'
            }
            rows={4}
            aria-label="first message"
            // Focus is applied imperatively (see the mount effect above) so
            // it can suppress the default scroll-into-view — see rationale
            // there. On mobile the landing is the default view; autofocusing
            // would pop the software keyboard on every app open, so it's
            // skipped entirely there (not just scroll-suppressed).
          />
          {!creatingChannel ? (
            <TopicComposerProviderRow
              providerOptions={providerOptions}
              selectedProviderId={selectedProviderId}
              selectedProviderOption={selectedProviderOption}
              providerUnavailable={providerUnavailable}
              onProviderChange={(providerId) => updateDraft({ providerId })}
            />
          ) : null}
          <div className="topic-composer__bar">
            <span className="topic-composer__context">
              {creatingChannel
                ? 'agents can collaborate here once you mention or invite them'
                : `using ${selectedProviderOption?.label ?? preview.providerLabel} in ${preview.cwdLabel}`}
            </span>
            <TuiButton
              variant="primary"
              type="submit"
              disabled={submitDisabled}
            >
              {creatingChannel
                ? submittingIntent === 'create-only'
                  ? 'creating…'
                  : 'create channel'
                : launchSubmitLabel({
                    submittingIntent,
                    launchDisabled,
                    launchFailure,
                  })}
            </TuiButton>
          </div>
          {!creatingChannel ? (
            <button
              type="button"
              className="topic-composer__advanced-toggle"
              aria-expanded={advancedOpen}
              aria-controls="topic-composer-advanced"
              onClick={() => setAdvancedOpen((prev) => !prev)}
            >
              <span aria-hidden="true">{advancedOpen ? '▾ ' : '▸ '}</span>
              route/context
            </button>
          ) : null}
          {!creatingChannel && advancedOpen ? (
            <div
              className="topic-composer__advanced"
              id="topic-composer-advanced"
            >
              <label>
                <span>title</span>
                <input
                  value={draft.title}
                  onChange={(event) =>
                    updateDraft({ title: event.target.value })
                  }
                  placeholder={
                    deriveTopicTitleFromPrompt(draft.prompt) ||
                    'auto from message'
                  }
                />
              </label>
              <label>
                <span>reference</span>
                <input
                  value={draft.taskRef}
                  onChange={(event) =>
                    updateDraft({ taskRef: event.target.value })
                  }
                  placeholder="github issue number or URL"
                />
              </label>
              <label>
                <span>agent id</span>
                <input
                  value={draft.agentId}
                  onChange={(event) =>
                    updateDraft({ agentId: event.target.value })
                  }
                  placeholder="optional agent identity"
                />
              </label>
              <label>
                <span>template kind</span>
                <select
                  value={draft.templateKind}
                  onChange={(event) =>
                    updateDraft({
                      templateKind: event.target
                        .value as WorkspaceTopicTemplateKind,
                    })
                  }
                >
                  {TOPIC_ROOM_TEMPLATE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>node</span>
                <input
                  list="topic-composer-node-options"
                  value={draft.nodeId}
                  onChange={(event) =>
                    updateDraft({ nodeId: event.target.value })
                  }
                  placeholder={
                    previewCreate.routingDefaults?.nodeId ??
                    'local/default node'
                  }
                />
                <datalist id="topic-composer-node-options">
                  {nodeOptions.map((node) => (
                    <option
                      key={node.value}
                      value={node.value}
                      label={node.label}
                    />
                  ))}
                </datalist>
              </label>
              <label>
                <span>repo</span>
                <input
                  list="topic-composer-repo-options"
                  value={draft.repoPath}
                  onChange={(event) =>
                    updateDraft({ repoPath: event.target.value })
                  }
                  placeholder={
                    previewCreate.routingDefaults?.repoPath ?? 'default repo'
                  }
                />
                <datalist id="topic-composer-repo-options">
                  {repoPathOptions.map((repoPath) => (
                    <option key={repoPath} value={repoPath} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>worktree</span>
                <input
                  list="topic-composer-worktree-options"
                  value={draft.worktreePath}
                  onChange={(event) =>
                    updateDraft({ worktreePath: event.target.value })
                  }
                  placeholder={
                    previewCreate.routingDefaults?.worktreePath ??
                    'default worktree'
                  }
                />
                <datalist id="topic-composer-worktree-options">
                  {worktreePathOptions.map((worktreePath) => (
                    <option key={worktreePath} value={worktreePath} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>cwd</span>
                <input
                  list="topic-composer-cwd-options"
                  value={draft.cwd}
                  onChange={(event) => updateDraft({ cwd: event.target.value })}
                  placeholder={
                    previewCreate.routingDefaults?.cwd ?? 'default cwd'
                  }
                />
                <datalist id="topic-composer-cwd-options">
                  {cwdOptions.map((cwd) => (
                    <option key={cwd} value={cwd} />
                  ))}
                </datalist>
              </label>
              <div
                className="topic-composer__preview"
                aria-label="launch preview"
              >
                <div>template: {preview.templateKind}</div>
                <div>
                  provider:{' '}
                  {selectedProviderOption?.label ?? preview.providerLabel}
                </div>
                <div>
                  agent:{' '}
                  {previewCreate.routingDefaults?.agentId ??
                    previewCreate.routingDefaults?.providerId ??
                    'default agent'}
                </div>
                <div>mode: {preview.modeLabel}</div>
                <div>node: {friendlyNodeLabel}</div>
                <div>cwd: {preview.cwdLabel}</div>
                <div>prompt: {preview.promptSources.join(', ')}</div>
                <div>tasks: {preview.taskRefs.join(', ')}</div>
                <div>side effects: {preview.sideEffects.join(' · ')}</div>
              </div>
              <div className="topic-composer__advanced-actions">
                <TuiButton
                  variant="ghost"
                  disabled={createOnlyDisabled}
                  onClick={() => void submit('create-only')}
                >
                  {submittingIntent === 'create-only'
                    ? 'creating…'
                    : 'create only'}
                </TuiButton>
              </div>
            </div>
          ) : null}
          {launchFailure ? (
            <div className="topic-composer__failure" role="alert">
              {launchFailure.stage === 'session'
                ? 'chat created, but terminal launch failed'
                : 'could not create chat'}{' '}
              — {launchFailure.message}
            </div>
          ) : null}
        </form>
        <div className="topic-composer__footer">
          {resume ? (
            <TuiButton variant="ghost" onClick={resume.onResume}>
              {resume.label}
            </TuiButton>
          ) : null}
          <span className="topic-composer__hint">
            enter to send · shift+enter for a new line · chats live in the
            sidebar
          </span>
        </div>
      </div>
    </div>
  );
}
