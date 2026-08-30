import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isValidHermesApiKey,
  isValidHermesProfile,
  type AgentProfile,
  type AgentProfileRespondTo,
} from '../../../../shared/agent-profile.js';
import type { FrameworkInfo } from '../../lib/types.js';
import {
  createAgentProfile,
  deleteAgentProfile,
  fetchAgentProfiles,
  setDefaultAgentProfile,
  updateAgentProfile,
  type AgentProfileWriteInput,
} from '../../lib/api.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { useConfigStore } from '../../lib/stores/config.js';
import AgentBadge from '../AgentBadge.js';
import SearchableSelect from '../SearchableSelect.js';
import TuiButton from '../TuiButton.js';
import TuiInput from '../TuiInput.js';
import { AgentAvatar } from '../chat/AgentAvatar.js';
import './SettingsAgentProfilesSection.css';

const AGENT_PROFILE_QUERY = ['agent-profiles'] as const;
/**
 * The only provider that consumes a gateway profile binding today. The server
 * keeps this fact in its `PROVIDER_DESCRIPTORS` row
 * (`agentProfileGatewayBindingKey`), which the browser cannot import, so the
 * editor gates on the catalog id the same way the rest of the frontend does.
 */
const HERMES_PROVIDER_ID = 'hermes';
const SEARCH_TERMS = [
  'agent',
  'agents',
  'profile',
  'profiles',
  'system prompt',
  'model',
  'effort',
  'environment',
  'respond to',
  'allowlist',
  'hermes',
  'hermes profile',
  'hermes api key',
  'api key',
];

export interface AgentProfileDraft {
  providerId: string;
  displayName: string;
  systemPrompt: string;
  model: string;
  effort: string;
  hermesProfile: string;
  /**
   * A NEWLY TYPED key, never a stored one: the server returns
   * `hermesApiKeySet` and never the value, so this box always starts empty and
   * an empty box means "leave the stored key alone".
   */
  hermesApiKey: string;
  /** Server-reported: a key is stored for this profile. */
  hermesApiKeyStored: boolean;
  /** The operator asked to clear the stored key; the save sends `null`. */
  hermesApiKeyCleared: boolean;
  envVars: EnvVarRow[];
  namePool: string;
  respondTo: AgentProfileRespondTo;
  respondToAllowlist: string;
}

export interface EnvVarRow {
  key: string;
  value: string;
}

export interface AgentProfileGroup {
  providerId: string;
  label: string;
  profiles: AgentProfile[];
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function splitLines(value: string): string[] | undefined {
  const entries = value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function envRecord(
  rows: readonly EnvVarRow[]
): Record<string, string> | undefined {
  const entries = rows
    .map(({ key, value }) => [key.trim(), value] as const)
    .filter(([key]) => key !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function profileDraftFrom(profile?: AgentProfile): AgentProfileDraft {
  return {
    providerId: profile?.providerId ?? '',
    displayName: profile?.displayName ?? '',
    systemPrompt: profile?.systemPrompt ?? '',
    model: profile?.model ?? '',
    effort: profile?.effort ?? '',
    hermesProfile: profile?.hermesProfile ?? '',
    hermesApiKey: '',
    hermesApiKeyStored: profile?.hermesApiKeySet === true,
    hermesApiKeyCleared: false,
    envVars: Object.entries(profile?.envVars ?? {}).map(([key, value]) => ({
      key,
      value,
    })),
    namePool: (profile?.namePool ?? []).join('\n'),
    respondTo: profile?.respondTo ?? 'anyone',
    respondToAllowlist: (profile?.respondToAllowlist ?? []).join('\n'),
  };
}

/**
 * Provider-owned model, effort and gateway-binding values cannot follow a
 * provider change. Dropping `hermesProfile` here is what makes a switch away
 * from hermes serialize as a `null` clear rather than carrying a stale binding.
 */
export function withProfileProvider(
  draft: AgentProfileDraft,
  providerId: string
): AgentProfileDraft {
  return {
    ...draft,
    providerId,
    model: '',
    effort: '',
    hermesProfile: '',
    // The gateway key belongs to the OLD provider's gateway. Marking it cleared
    // (rather than merely forgetting it) is what makes the save send an
    // explicit `null`, so the secret does not survive as dead credential
    // material on a row that can no longer use it.
    hermesApiKey: '',
    hermesApiKeyCleared: draft.hermesApiKeyStored || draft.hermesApiKeyCleared,
    hermesApiKeyStored: false,
  };
}

/**
 * Inline validation message for the hermes profile field, or null when the
 * draft is submittable. Mirrors the server's `isValidHermesProfile`: the value
 * becomes a URL path segment, so `.`, `..` and anything outside
 * `HERMES_PROFILE_PATTERN` are rejected before a save is offered.
 */
export function hermesProfileDraftError(
  draft: AgentProfileDraft
): string | null {
  if (draft.providerId !== HERMES_PROVIDER_ID) return null;
  const value = draft.hermesProfile.trim();
  if (!value) return null;
  if (isValidHermesProfile(value)) return null;
  return 'use up to 64 letters, digits, dot, dash or underscore; "." and ".." are not allowed.';
}

/**
 * Inline validation for the gateway key field. Mirrors the server's
 * `isValidHermesApiKey`; the message never repeats the typed value.
 */
export function hermesApiKeyDraftError(
  draft: AgentProfileDraft
): string | null {
  if (draft.providerId !== HERMES_PROVIDER_ID) return null;
  const value = draft.hermesApiKey.trim();
  if (!value) return null;
  if (isValidHermesApiKey(value)) return null;
  return 'use printable characters with no spaces (max 4096).';
}

/** The one-line state of the stored key, for the field's hint. */
export function hermesApiKeyStatus(draft: AgentProfileDraft): string {
  if (draft.hermesApiKey.trim()) {
    return draft.hermesApiKeyStored ? 'set · replaced on save' : 'set on save';
  }
  if (draft.hermesApiKeyCleared) return 'not set · cleared on save';
  return draft.hermesApiKeyStored ? 'set' : 'not set';
}

export function profileSubmitInput(
  draft: AgentProfileDraft,
  options: { clearEmpty?: boolean } = {}
): AgentProfileWriteInput {
  const displayName = optionalText(draft.displayName);
  const systemPrompt = optionalText(draft.systemPrompt);
  const model = optionalText(draft.model);
  const effort = optionalText(draft.effort);
  const hermesProfile =
    draft.providerId === HERMES_PROVIDER_ID
      ? optionalText(draft.hermesProfile)
      : undefined;
  // WRITE-ONLY, so this field breaks the `clearEmpty` rule the others follow:
  // an empty box is "keep the stored key", never "clear it". Only a typed value
  // or an explicit clear is ever sent.
  const typedApiKey =
    draft.providerId === HERMES_PROVIDER_ID
      ? optionalText(draft.hermesApiKey)
      : undefined;
  const envVars = envRecord(draft.envVars);
  const namePool = splitLines(draft.namePool);
  const respondToAllowlist =
    draft.respondTo === 'allowlist'
      ? splitLines(draft.respondToAllowlist)
      : undefined;
  return {
    providerId: draft.providerId,
    ...(displayName
      ? { displayName }
      : options.clearEmpty
        ? { displayName: '' }
        : {}),
    ...(systemPrompt || options.clearEmpty
      ? { systemPrompt: systemPrompt ?? null }
      : {}),
    ...(model || options.clearEmpty ? { model: model ?? null } : {}),
    ...(effort || options.clearEmpty ? { effort: effort ?? null } : {}),
    ...(hermesProfile || options.clearEmpty
      ? { hermesProfile: hermesProfile ?? null }
      : {}),
    ...(typedApiKey
      ? { hermesApiKey: typedApiKey }
      : draft.hermesApiKeyCleared
        ? { hermesApiKey: null }
        : {}),
    ...(envVars || options.clearEmpty ? { envVars: envVars ?? null } : {}),
    ...(namePool || options.clearEmpty ? { namePool: namePool ?? null } : {}),
    respondTo: draft.respondTo,
    ...(respondToAllowlist || options.clearEmpty
      ? { respondToAllowlist: respondToAllowlist ?? null }
      : {}),
  };
}

/** Group by the live configured framework catalog; never copy vendor metadata. */
export function groupAgentProfiles(
  profiles: readonly AgentProfile[],
  frameworks: readonly FrameworkInfo[]
): AgentProfileGroup[] {
  const labels = new Map(
    frameworks.map((framework) => [framework.id, framework.displayName])
  );
  const ids = [
    ...frameworks.map((framework) => framework.id),
    ...profiles
      .map((profile) => profile.providerId)
      .filter((providerId) => !labels.has(providerId))
      .sort(),
  ];
  return [...new Set(ids)]
    .map((providerId) => ({
      providerId,
      label: labels.get(providerId) ?? providerId,
      profiles: profiles.filter((profile) => profile.providerId === providerId),
    }))
    .filter((group) => group.profiles.length > 0);
}

function matchesSearch(searchQuery: string): boolean {
  const query = searchQuery.trim().toLowerCase();
  return (
    !query ||
    SEARCH_TERMS.some((term) => term.includes(query) || query.includes(term))
  );
}

function displayName(profile: AgentProfile, framework?: FrameworkInfo): string {
  return profile.displayName || framework?.displayName || profile.providerId;
}

/** Compact multiline counterpart to TuiInput's terminal block cursor. */
function AgentProfileTextarea({
  value,
  onChange,
  placeholder,
  rows,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const [focused, setFocused] = useState(false);
  const [idle, setIdle] = useState(true);
  const [cursorMeasure, setCursorMeasure] = useState({
    prefix: '',
    scrollLeft: 0,
    scrollTop: 0,
  });
  const [cursor, setCursor] = useState({ left: 0, top: 0, height: 18 });

  const updateCursor = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    setCursorMeasure({
      prefix: textarea.value.slice(0, textarea.selectionStart ?? 0),
      scrollLeft: textarea.scrollLeft,
      scrollTop: textarea.scrollTop,
    });
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const marker = markerRef.current;
    if (!textarea || !marker) return;
    const style = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight) || 18;
    setCursor({
      left: marker.offsetLeft - cursorMeasure.scrollLeft,
      top: marker.offsetTop - cursorMeasure.scrollTop,
      height: lineHeight,
    });
  }, [cursorMeasure]);

  const markTyping = () => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), 530);
  };

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    []
  );

  return (
    <div className="agent-profiles-textarea">
      <textarea
        ref={textareaRef}
        value={value}
        onInput={(event) => {
          onChange(event.currentTarget.value);
          markTyping();
          requestAnimationFrame(updateCursor);
        }}
        onFocus={() => {
          setFocused(true);
          updateCursor();
        }}
        onBlur={() => {
          setFocused(false);
          setIdle(true);
        }}
        onClick={() => requestAnimationFrame(updateCursor)}
        onKeyDown={() => {
          markTyping();
          requestAnimationFrame(updateCursor);
        }}
        onScroll={updateCursor}
        placeholder={placeholder}
        rows={rows}
      />
      <div className="agent-profiles-textarea__mirror" aria-hidden="true">
        {cursorMeasure.prefix}
        <span ref={markerRef} className="agent-profiles-textarea__marker">
          █
        </span>
      </div>
      {focused ? (
        <span
          className={['agent-profiles-textarea__cursor', idle ? 'is-idle' : '']
            .filter(Boolean)
            .join(' ')}
          style={{ left: cursor.left, top: cursor.top, height: cursor.height }}
          aria-hidden="true"
        >
          █
        </span>
      ) : null}
    </div>
  );
}

function ProfileCard({
  profile,
  framework,
  onEdit,
  onDuplicate,
  onDelete,
  onSetDefault,
}: {
  profile: AgentProfile;
  framework?: FrameworkInfo;
  onEdit: (profile: AgentProfile) => void;
  onDuplicate: (profile: AgentProfile) => void;
  onDelete: (profile: AgentProfile) => void;
  onSetDefault: (profile: AgentProfile) => void;
}) {
  const name = displayName(profile, framework);
  const identity = resolveSenderIdentity({
    kind: 'agent',
    id: profile.id,
    providerId: profile.providerId,
    displayName: name,
  });
  const builtIn = profile.isBuiltIn;
  return (
    <article className="agent-profiles-card" data-profile-id={profile.id}>
      <div className="agent-profiles-card__identity">
        <span className="agent-profiles-card__icon-slot" aria-hidden="true">
          <AgentBadge agent={identity.glyph ?? profile.providerId} />
        </span>
        <AgentAvatar identity={identity} name={name} size={24} />
        <div className="agent-profiles-card__name">
          <strong>{name}</strong>
          <span>
            {profile.providerId === HERMES_PROVIDER_ID && profile.hermesProfile
              ? `${profile.providerId} · ${profile.hermesProfile}`
              : profile.providerId}
          </span>
        </div>
        {profile.isDefault ? (
          <span className="agent-profiles-card__default">default</span>
        ) : null}
      </div>
      {builtIn ? (
        <p className="agent-profiles-card__restriction">
          {profile.isDefault
            ? 'built-in default; vendor settings stay in the configured framework.'
            : 'built-in profile; provider identity is managed by the configured framework.'}
        </p>
      ) : null}
      <div className="agent-profiles-card__actions">
        <TuiButton variant="ghost" size="sm" onClick={() => onEdit(profile)}>
          edit
        </TuiButton>
        <TuiButton
          variant="ghost"
          size="sm"
          onClick={() => onDuplicate(profile)}
        >
          duplicate
        </TuiButton>
        <TuiButton
          variant="ghost"
          size="sm"
          onClick={() => onSetDefault(profile)}
          disabled={profile.isDefault}
        >
          set default
        </TuiButton>
        <TuiButton
          variant="danger"
          size="sm"
          onClick={() => onDelete(profile)}
          disabled={profile.isDefault}
        >
          delete
        </TuiButton>
      </div>
    </article>
  );
}

export function AgentProfileEditor({
  profile,
  frameworks,
  onCancel,
  onSubmit,
  submitting = false,
}: {
  profile?: AgentProfile;
  frameworks: readonly FrameworkInfo[];
  onCancel: () => void;
  onSubmit: (input: AgentProfileWriteInput) => void;
  submitting?: boolean;
}) {
  const [draft, setDraft] = useState(() => profileDraftFrom(profile));
  const isEdit = Boolean(profile?.id);
  const hermesError = hermesProfileDraftError(draft);
  const hermesKeyError = hermesApiKeyDraftError(draft);
  const fieldId = useId();
  const hermesHintId = `${fieldId}-hermes-profile-hint`;
  const hermesErrorId = `${fieldId}-hermes-profile-error`;
  const hermesKeyHintId = `${fieldId}-hermes-api-key-hint`;
  const hermesKeyErrorId = `${fieldId}-hermes-api-key-error`;
  const set = <K extends keyof AgentProfileDraft>(
    key: K,
    value: AgentProfileDraft[K]
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const setEnv = (index: number, field: keyof EnvVarRow, value: string) =>
    setDraft((current) => ({
      ...current,
      envVars: current.envVars.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value } : row
      ),
    }));

  return (
    <form
      className="agent-profiles-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !draft.providerId ||
          hermesProfileDraftError(draft) ||
          hermesApiKeyDraftError(draft)
        ) {
          return;
        }
        onSubmit(profileSubmitInput(draft, { clearEmpty: isEdit }));
      }}
    >
      <div className="agent-profiles-editor__heading">
        <h4>{isEdit ? 'edit profile' : 'new profile'}</h4>
        <p>
          avatar upload is deferred; initials and vendor glyph are used here.
        </p>
      </div>
      <label>
        configured framework
        <SearchableSelect
          value={draft.providerId}
          placeholder="select framework"
          options={frameworks.map((framework) => ({
            value: framework.id,
            label: framework.displayName,
          }))}
          onchange={(providerId) =>
            setDraft(withProfileProvider(draft, providerId))
          }
          {...(profile?.isBuiltIn ? { disabled: true } : {})}
        />
      </label>
      <label>
        display name
        <TuiInput
          value={draft.displayName}
          onChange={(value) => set('displayName', value)}
          placeholder="e.g. reviewer codex"
        />
      </label>
      <label>
        system prompt
        <AgentProfileTextarea
          value={draft.systemPrompt}
          onChange={(value) => set('systemPrompt', value)}
          placeholder="optional launch-time instruction"
          rows={3}
        />
      </label>
      <div className="agent-profiles-editor__two-up">
        <label>
          model
          <TuiInput
            value={draft.model}
            onChange={(value) => set('model', value)}
            placeholder="provider-defined"
          />
        </label>
        <label>
          effort
          <TuiInput
            value={draft.effort}
            onChange={(value) => set('effort', value)}
            placeholder="provider-defined"
          />
        </label>
      </div>
      {draft.providerId === HERMES_PROVIDER_ID ? (
        <div className="agent-profiles-editor__two-up">
          <label>
            hermes profile
            <TuiInput
              value={draft.hermesProfile}
              onChange={(value) => set('hermesProfile', value)}
              placeholder="hermes default"
              /*
               * The hint and error spans sit inside this `<label>`, so the
               * computed accessible name would otherwise swallow both. This
               * override is load-bearing, not boilerplate — do not delete it
               * without moving those spans out of the label first.
               */
              aria-label="hermes profile"
              aria-invalid={hermesError ? 'true' : 'false'}
              aria-describedby={
                hermesError ? `${hermesHintId} ${hermesErrorId}` : hermesHintId
              }
            />
            <span
              id={hermesHintId}
              className="agent-profiles-editor__field-hint"
            >
              optional. leave blank to use the hermes default profile.
            </span>
            {hermesError ? (
              <span
                id={hermesErrorId}
                className="agent-profiles-editor__field-error"
                role="alert"
              >
                {hermesError}
              </span>
            ) : null}
          </label>
          <div className="agent-profiles-editor__secret">
            <label>
              hermes api key
              <TuiInput
                type="password"
                value={draft.hermesApiKey}
                onChange={(value) => set('hermesApiKey', value)}
                /*
                 * Not a login field: keep the browser from autofilling the
                 * operator's site password into it, or offering to remember
                 * the gateway key as one.
                 */
                autoComplete="new-password"
                spellCheck={false}
                placeholder={
                  draft.hermesApiKeyStored ? 'stored' : 'gateway default key'
                }
                /*
                 * Same load-bearing override as the profile field above: the
                 * status and error spans live outside this label precisely so a
                 * secret's state is announced without the value ever rendering.
                 */
                aria-label="hermes api key"
                aria-invalid={hermesKeyError ? 'true' : 'false'}
                aria-describedby={
                  hermesKeyError
                    ? `${hermesKeyHintId} ${hermesKeyErrorId}`
                    : hermesKeyHintId
                }
              />
            </label>
            <div className="agent-profiles-editor__secret-state">
              <span
                id={hermesKeyHintId}
                className="agent-profiles-editor__field-hint"
              >
                {hermesApiKeyStatus(draft)} · relay never returns a saved key.
              </span>
              {draft.hermesApiKeyStored ? (
                <TuiButton
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      hermesApiKey: '',
                      hermesApiKeyCleared: true,
                    }))
                  }
                >
                  clear
                </TuiButton>
              ) : null}
              {draft.hermesApiKeyCleared ? (
                <TuiButton
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      hermesApiKeyCleared: false,
                    }))
                  }
                >
                  keep
                </TuiButton>
              ) : null}
            </div>
            {hermesKeyError ? (
              <span
                id={hermesKeyErrorId}
                className="agent-profiles-editor__field-error"
                role="alert"
              >
                {hermesKeyError}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <fieldset className="agent-profiles-editor__env">
        <legend>environment variables</legend>
        {draft.envVars.map((row, index) => (
          <div className="agent-profiles-editor__env-row" key={index}>
            <TuiInput
              value={row.key}
              onChange={(value) => setEnv(index, 'key', value)}
              placeholder="key"
              aria-label={`environment variable ${index + 1} key`}
            />
            <TuiInput
              value={row.value}
              onChange={(value) => setEnv(index, 'value', value)}
              placeholder="value"
              aria-label={`environment variable ${index + 1} value`}
            />
            <TuiButton
              variant="ghost"
              size="sm"
              onClick={() =>
                set(
                  'envVars',
                  draft.envVars.filter((_, rowIndex) => rowIndex !== index)
                )
              }
            >
              remove
            </TuiButton>
          </div>
        ))}
        <TuiButton
          variant="ghost"
          size="sm"
          onClick={() =>
            set('envVars', [...draft.envVars, { key: '', value: '' }])
          }
        >
          add variable
        </TuiButton>
      </fieldset>
      <label>
        name pool
        <AgentProfileTextarea
          value={draft.namePool}
          onChange={(value) => set('namePool', value)}
          placeholder="one alternate name per line"
          rows={2}
        />
      </label>
      <label>
        respond to
        <SearchableSelect
          value={draft.respondTo}
          options={[
            { value: 'anyone', label: 'anyone' },
            { value: 'owner-only', label: 'owner only' },
            { value: 'allowlist', label: 'allowlist' },
          ]}
          onchange={(respondTo) =>
            set('respondTo', respondTo as AgentProfileRespondTo)
          }
        />
      </label>
      {draft.respondTo === 'allowlist' ? (
        <label>
          allowlist
          <AgentProfileTextarea
            value={draft.respondToAllowlist}
            onChange={(value) => set('respondToAllowlist', value)}
            placeholder="one actor id per line"
            rows={2}
          />
        </label>
      ) : null}
      <div className="agent-profiles-editor__actions">
        <TuiButton
          variant="primary"
          type="submit"
          disabled={
            submitting ||
            !draft.providerId ||
            Boolean(hermesError) ||
            Boolean(hermesKeyError) ||
            (!isEdit && !draft.displayName.trim())
          }
        >
          {submitting ? 'saving…' : isEdit ? 'save profile' : 'create profile'}
        </TuiButton>
        <TuiButton variant="ghost" onClick={onCancel} disabled={submitting}>
          cancel
        </TuiButton>
      </div>
    </form>
  );
}

export function AgentProfileGallery({
  profiles,
  frameworks,
  onEdit,
  onDuplicate,
  onDelete,
  onSetDefault,
}: {
  profiles: readonly AgentProfile[];
  frameworks: readonly FrameworkInfo[];
  onEdit: (profile: AgentProfile) => void;
  onDuplicate: (profile: AgentProfile) => void;
  onDelete: (profile: AgentProfile) => void;
  onSetDefault: (profile: AgentProfile) => void;
}) {
  const groups = groupAgentProfiles(profiles, frameworks);
  return (
    <>
      {groups.map((group) => {
        const framework = frameworks.find(
          (item) => item.id === group.providerId
        );
        return (
          <div className="agent-profiles-group" key={group.providerId}>
            <h4>{group.label}</h4>
            <div className="agent-profiles-grid">
              {group.profiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  {...(framework ? { framework } : {})}
                  onEdit={onEdit}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                  onSetDefault={onSetDefault}
                />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function SettingsAgentProfilesSection({
  searchQuery,
}: {
  searchQuery: string;
}) {
  const queryClient = useQueryClient();
  const frameworks = useConfigStore((state) => state.frameworks);
  const [editing, setEditing] = useState<AgentProfile | null | undefined>(
    undefined
  );
  const profilesQuery = useQuery({
    queryKey: AGENT_PROFILE_QUERY,
    queryFn: fetchAgentProfiles,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: AGENT_PROFILE_QUERY });
  const createMutation = useMutation({
    mutationFn: createAgentProfile,
    onSuccess: () => {
      setEditing(undefined);
      void invalidate();
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: AgentProfileWriteInput;
    }) => updateAgentProfile(id, input),
    onSuccess: () => {
      setEditing(undefined);
      void invalidate();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: deleteAgentProfile,
    onSuccess: () => void invalidate(),
  });
  const defaultMutation = useMutation({
    mutationFn: setDefaultAgentProfile,
    onSuccess: () => void invalidate(),
  });
  const groups = useMemo(
    () => groupAgentProfiles(profilesQuery.data ?? [], frameworks),
    [frameworks, profilesQuery.data]
  );

  return (
    <section
      id="section-agent-profiles"
      className={[
        'settings-dialog-section',
        !matchesSearch(searchQuery) ? 'dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <h3 className="settings-dialog-section-heading">agent profiles</h3>
      <div className="agent-profiles-section">
        <div className="agent-profiles-section__intro">
          <p>profiles are local overlays on configured frameworks.</p>
          {editing === undefined ? (
            <TuiButton
              variant="primary"
              size="sm"
              onClick={() => setEditing(null)}
            >
              add profile
            </TuiButton>
          ) : null}
        </div>
        {editing !== undefined ? (
          <AgentProfileEditor
            /*
             * The editor seeds its draft ONCE from `profile`, and the gallery
             * stays mounted while it is open — so every card's edit/duplicate
             * button is live. Without a key, clicking edit on a second profile
             * re-renders the same instance, leaving the first profile's draft
             * in place while the submit handler addresses the second profile's
             * id: one profile's `hermesProfile` would be written onto another
             * row, or cleared off it. Remounting per edited row is what makes
             * `profileDraftFrom` re-run.
             */
            key={editing?.id || 'new'}
            {...(editing ? { profile: editing } : {})}
            frameworks={frameworks}
            submitting={createMutation.isPending || updateMutation.isPending}
            onCancel={() => setEditing(undefined)}
            onSubmit={(input) => {
              if (editing?.id) updateMutation.mutate({ id: editing.id, input });
              else createMutation.mutate(input);
            }}
          />
        ) : null}
        {profilesQuery.isPending ? (
          <p className="agent-profiles-section__state">loading profiles…</p>
        ) : profilesQuery.isError ? (
          <p className="agent-profiles-section__state agent-profiles-section__state--error">
            unable to load profiles; retry from settings.
          </p>
        ) : groups.length === 0 ? (
          <p className="agent-profiles-section__state">
            no configured profiles.
          </p>
        ) : (
          <AgentProfileGallery
            profiles={profilesQuery.data ?? []}
            frameworks={frameworks}
            onEdit={setEditing}
            onDuplicate={(source) => {
              // A duplicate starts with NO gateway key: the secret lives in
              // its own column and is never copied, so carrying the marker
              // across would make the editor claim a key the copy has not got.
              const { hermesApiKeySet: _omitted, ...copyable } = source;
              setEditing({
                ...copyable,
                id: '',
                isDefault: false,
                isBuiltIn: false,
                displayName: source.displayName
                  ? `${source.displayName} copy`
                  : '',
              });
            }}
            onDelete={(source) => {
              if (
                !window.confirm(
                  `delete ${displayName(source)}? this cannot be undone.`
                )
              ) {
                return;
              }
              deleteMutation.mutate(source.id);
            }}
            onSetDefault={(source) => defaultMutation.mutate(source.id)}
          />
        )}
        {createMutation.error ||
        updateMutation.error ||
        deleteMutation.error ||
        defaultMutation.error ? (
          <p className="agent-profiles-section__state agent-profiles-section__state--error">
            profile change failed; no local profile data was discarded.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default SettingsAgentProfilesSection;
