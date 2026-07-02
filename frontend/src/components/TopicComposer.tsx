import {
  useEffect,
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
import {
  launchSubmitLabel,
  launchTypeForTemplate,
  deriveTopicTitleFromPrompt,
  TOPIC_ROOM_TEMPLATE_OPTIONS,
  type TopicProviderOption,
} from '../lib/topic-create.js';
import { TOPIC_COMPOSER_FOCUS_EVENT } from '../lib/topic-task-room.js';
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
  return (
    <label className="topic-composer__provider-row">
      <span className="topic-composer__provider-label">coding agent</span>
      <select
        className="topic-composer__provider-select"
        value={selectedProviderId}
        onChange={(event) => onProviderChange(event.currentTarget.value)}
        aria-describedby="topic-composer-provider-status"
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
        id="topic-composer-provider-status"
      >
        {selectedProviderOption?.status ?? 'global default · tui launch'}
      </span>
    </label>
  );
}

function primaryIntentForTemplate(templateKind: WorkspaceTopicTemplateKind) {
  return templateKind === 'note' ? 'create-only' : 'create-and-launch';
}

function composerSubmitDisabled(input: {
  effectiveTitle: string;
  submitting: boolean;
  providerUnavailable: boolean;
}) {
  return !input.effectiveTitle || input.submitting || input.providerUnavailable;
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
  const {
    draft,
    updateDraft,
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
  } = useTopicRoomCreate({ onLaunched: onSelectSession });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Focus request from openTopicTaskRoom() — covers the already-on-landing
  // case where the component does not remount so autoFocus never re-fires.
  useEffect(() => {
    const focus = () => taRef.current?.focus();
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
          type: launchTypeForTemplate(draft.templateKind) ?? 'agent',
          mode: launchMode ?? 'pty',
          agent: previewCreate.routingDefaults?.providerId,
          nodeId: previewCreate.routingDefaults?.nodeId,
          repoPath: previewCreate.routingDefaults?.repoPath,
          worktreePath: previewCreate.routingDefaults?.worktreePath,
          cwd: previewCreate.routingDefaults?.cwd,
        },
      }),
    [draft.templateKind, launchMode, previewCreate]
  );
  const launchDisabled = draft.templateKind === 'note';
  // Notes are rooms without a session — the primary action degrades to
  // create-only instead of dead-ending the keyboard.
  const primaryIntent = primaryIntentForTemplate(draft.templateKind);
  const providerUnavailable = Boolean(selectedProviderOption?.disabled);
  const disabled = composerSubmitDisabled({
    effectiveTitle,
    submitting: Boolean(submittingIntent),
    providerUnavailable,
  });
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
        <span className="topic-composer__title">start a topic</span>
        <form
          className="topic-composer__form"
          aria-label="new topic"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!disabled) void submit(primaryIntent);
          }}
        >
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
                !disabled
              ) {
                event.preventDefault();
                void submit(primaryIntent);
              } else if (event.key === 'Escape') {
                // Composer opened over an active session — Escape returns to
                // it. No-op on the bare landing (flag already false).
                setTopicComposerOpen(false);
              }
            }}
            placeholder="what should the agent do?"
            rows={4}
            aria-label="first message"
            // On mobile the landing is the default view; autofocusing would
            // pop the software keyboard on every app open.
            autoFocus={!isMobileDevice}
          />
          <TopicComposerProviderRow
            providerOptions={providerOptions}
            selectedProviderId={selectedProviderId}
            selectedProviderOption={selectedProviderOption}
            providerUnavailable={providerUnavailable}
            onProviderChange={(providerId) => updateDraft({ providerId })}
          />
          <div className="topic-composer__bar">
            <span className="topic-composer__context">
              {selectedProviderOption?.label ?? preview.providerLabel} ·{' '}
              {preview.modeLabel} · {friendlyNodeLabel} · {preview.cwdLabel}
            </span>
            <TuiButton variant="primary" type="submit" disabled={disabled}>
              {launchSubmitLabel({
                submittingIntent,
                launchDisabled,
                launchFailure,
              })}
            </TuiButton>
          </div>
          <button
            type="button"
            className="topic-composer__advanced-toggle"
            aria-expanded={advancedOpen}
            aria-controls="topic-composer-advanced"
            onClick={() => setAdvancedOpen((prev) => !prev)}
          >
            <span aria-hidden="true">{advancedOpen ? '▾ ' : '▸ '}</span>
            advanced
          </button>
          {advancedOpen ? (
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
                <span>task ref</span>
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
              <div className="topic-composer__preview" aria-label="launch preview">
                <div>template: {preview.templateKind}</div>
                <div>
                  provider: {selectedProviderOption?.label ?? preview.providerLabel}
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
                  disabled={disabled}
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
                ? 'launch failed after room creation'
                : 'room creation failed'}{' '}
              ({launchFailure.stage}): {launchFailure.message}
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
            enter to start · shift+enter for a new line · topics and sessions
            live in the sidebar
          </span>
        </div>
      </div>
    </div>
  );
}
