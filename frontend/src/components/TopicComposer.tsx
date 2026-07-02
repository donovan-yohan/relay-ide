import { useMemo, useState, type FormEvent } from 'react';
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
} from '../lib/topic-create.js';
import TuiButton from './TuiButton.js';
import './TopicComposer.css';

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
    nodeOptions,
    repoPathOptions,
    worktreePathOptions,
    cwdOptions,
  } = useTopicRoomCreate({ onLaunched: onSelectSession });
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const preview = useMemo(
    () =>
      buildWorkspaceTopicLaunchPreview({
        create: previewCreate,
        intent:
          draft.templateKind === 'note' ? 'create-only' : 'create-and-launch',
        templateKind: draft.templateKind,
        launchOverrides: {
          type: launchTypeForTemplate(draft.templateKind) ?? 'agent',
          mode: 'pty',
          agent: previewCreate.routingDefaults?.providerId,
          nodeId: previewCreate.routingDefaults?.nodeId,
          repoPath: previewCreate.routingDefaults?.repoPath,
          worktreePath: previewCreate.routingDefaults?.worktreePath,
          cwd: previewCreate.routingDefaults?.cwd,
        },
      }),
    [draft.templateKind, previewCreate]
  );
  const launchDisabled = draft.templateKind === 'note';
  const disabled = !effectiveTitle || Boolean(submittingIntent);
  // #1103: never render a raw node id — resolve through the roster or fall
  // back to a generic label.
  const routedNodeId = previewCreate.routingDefaults?.nodeId;
  const friendlyNodeLabel = routedNodeId
    ? nodes.find((node) => node.nodeId === routedNodeId)?.displayName ||
      'remote node'
    : preview.nodeLabel;

  return (
    <div className="topic-composer">
      <div className="topic-composer__panel">
        <span className="topic-composer__title">start a topic</span>
        <form
          className="topic-composer__form"
          aria-label="new topic"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!disabled && !launchDisabled) void submit('create-and-launch');
          }}
        >
          <textarea
            className="topic-composer__ta"
            value={draft.prompt}
            onChange={(event) => updateDraft({ prompt: event.target.value })}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !disabled &&
                !launchDisabled
              ) {
                event.preventDefault();
                void submit('create-and-launch');
              }
            }}
            placeholder="what should the agent do?"
            rows={4}
            aria-label="first message"
            autoFocus
          />
          <div className="topic-composer__bar">
            <span className="topic-composer__context">
              {preview.providerLabel} · {friendlyNodeLabel} ·{' '}
              {preview.cwdLabel}
            </span>
            <TuiButton
              variant="primary"
              type="submit"
              disabled={disabled || launchDisabled}
            >
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
            onClick={() => setAdvancedOpen((prev) => !prev)}
          >
            <span aria-hidden="true">{advancedOpen ? '▾ ' : '▸ '}</span>
            advanced
          </button>
          {advancedOpen ? (
            <div className="topic-composer__advanced">
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
                <span>provider</span>
                <input
                  list="topic-composer-provider-options"
                  value={draft.providerId}
                  onChange={(event) =>
                    updateDraft({ providerId: event.target.value })
                  }
                  placeholder={
                    previewCreate.routingDefaults?.providerId ??
                    'default provider'
                  }
                />
                <datalist id="topic-composer-provider-options">
                  {providerOptions.map((providerId) => (
                    <option key={providerId} value={providerId} />
                  ))}
                </datalist>
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
                <div>provider: {preview.providerLabel}</div>
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
                <button
                  type="button"
                  className="topic-composer__create-only"
                  disabled={disabled}
                  onClick={() => void submit('create-only')}
                >
                  {submittingIntent === 'create-only'
                    ? 'creating…'
                    : 'create only'}
                </button>
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
