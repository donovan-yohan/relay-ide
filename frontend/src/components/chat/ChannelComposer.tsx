import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import './ChannelComposer.css';
import { useQuery } from '@tanstack/react-query';
import type {
  ChannelImagePart,
  ChannelMemberRef,
  ChannelMessagePart,
  ChannelPostSteering,
} from '../../../../shared/channel-chat-protocol.js';
import {
  filterMentionContacts,
  isMentionContactSelectable,
  mentionInsertText,
  type MentionContact,
} from '../../../../shared/mention-contacts.js';
import type { AgentSlashCommandV2 } from '../../../../shared/agent-chat-protocol-v2.js';
import { createBrowserId } from '../../lib/browserId.js';
import {
  executeChannelAgentCommand,
  fetchChannelRoster,
  uploadChannelImages,
  type RosterEntry,
} from '../../lib/api.js';
import { buildMentionContacts } from '../../lib/chat/mention-contacts.js';
import { detectTrigger } from './slashTrigger.js';
import { createLineBreakSubmitGuard } from './composerInput.js';
import {
  AgentCommandPalette,
  type AgentCommandPaletteRow,
} from './AgentCommandPalette.js';
import { MentionPalette } from './MentionPalette.js';

const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
export const CHANNEL_COMPOSER_MAX_IMAGES = 4;
export const CHANNEL_COMPOSER_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type BusyAgentSteeringMode = 'all' | 'some' | 'none';

/** Tooltip for the default delivery path — names who receives the message. */
function defaultSendHint(
  busyAgentLabels: readonly string[],
  steeringMode: BusyAgentSteeringMode
): string {
  const first = busyAgentLabels[0];
  if (steeringMode === 'all') {
    return busyAgentLabels.length === 1 && first
      ? `steer ${first} after its next safe tool boundary`
      : 'steer agents after their next safe tool boundary';
  }
  if (steeringMode === 'some') {
    return 'steer supported agents at a safe boundary; queue the rest';
  }
  return busyAgentLabels.length === 1 && first
    ? `queue behind ${first}'s turn`
    : 'queue behind the current turn';
}

function defaultSendLabel(steeringMode: BusyAgentSteeringMode): string {
  if (steeringMode === 'all') return 'steer';
  if (steeringMode === 'some') return 'steer / queue';
  return 'queue';
}

type CommandPhase = 'arguments' | 'confirm' | null;

interface MentionCommandTrigger {
  contact: MentionContact;
  rosterEntry: RosterEntry | undefined;
  /** Includes the selected profile mention and immediately-adjacent `/`. */
  commandStart: number;
  /** End of the command-name token (before a possible argument). */
  commandEnd: number;
  commandQuery: string;
  argument: string;
}

function isMentionBoundary(text: string, at: number): boolean {
  return at === 0 || !/[A-Za-z0-9_.]/.test(text.charAt(at - 1));
}

/**
 * Resolve only an EXACT addressable mention immediately followed by `/`.
 * Comparing against `mentionInsertText` preserves custom-profile collision
 * tokens (`@Reviewer#abc123/`) instead of guessing identity from display text.
 */
function detectMentionCommandTrigger(
  text: string,
  caret: number,
  contacts: readonly MentionContact[],
  roster: readonly RosterEntry[]
): MentionCommandTrigger | null {
  const beforeCaret = text.slice(0, caret);
  let best:
    | { contact: MentionContact; index: number; needle: string }
    | undefined;
  for (const contact of contacts) {
    const mention = mentionInsertText(contact);
    // MentionPalette inserts a single trailing space. Accept that exact bridge
    // as well as the compact hand-typed `@codex/`, but never arbitrary prose.
    const candidates = [`${mention}/`, `${mention} /`];
    for (const needle of candidates) {
      const index = beforeCaret.toLowerCase().lastIndexOf(needle.toLowerCase());
      if (index < 0 || !isMentionBoundary(beforeCaret, index)) continue;
      const rest = beforeCaret.slice(index + needle.length);
      if (/\n/.test(rest)) continue;
      if (!best || index > best.index) best = { contact, index, needle };
    }
  }
  if (!best) return null;
  const rest = beforeCaret.slice(best.index + best.needle.length);
  const nameMatch = /^(\S*)/.exec(rest);
  const commandQuery = nameMatch?.[1] ?? '';
  const commandEnd = best.index + best.needle.length + commandQuery.length;
  return {
    contact: best.contact,
    rosterEntry: roster.find((entry) => entry.id === best.contact.id),
    commandStart: best.index,
    commandEnd,
    commandQuery,
    argument: rest.slice(commandQuery.length).trim(),
  };
}

function commandMatches(command: AgentSlashCommandV2, query: string): boolean {
  const normalized = query.toLowerCase();
  return (
    normalized.length === 0 ||
    command.name.toLowerCase().startsWith(normalized) ||
    (command.aliases ?? []).some((alias) =>
      alias.toLowerCase().startsWith(normalized)
    )
  );
}

function needsConfirmation(command: AgentSlashCommandV2): boolean {
  return (
    command.destructive === true ||
    ['clear', 'new', 'reset', 'rollback', 'archive'].includes(
      command.collisionKey ?? command.name
    )
  );
}

interface PendingImage {
  localId: string;
  file: File;
  name: string;
  previewUrl: string;
  status: 'uploading' | 'ready' | 'failed';
  part?: ChannelImagePart;
  error?: string;
}

interface ChannelComposerProps {
  channelId: string;
  channelTitle: string;
  placeholder?: string;
  /** Human channel members, folded into the @mention contact set (#1236). */
  members?: readonly ChannelMemberRef[];
  /** Idempotent send: the SAME clientMessageId is reused across manual retries. */
  onSend: (
    text: string,
    clientMessageId: string,
    parts: ChannelMessagePart[],
    steering?: ChannelPostSteering
  ) => Promise<void>;
  /**
   * Labels of the bound agents that are mid-turn right now. Non-empty reveals
   * the steering cluster; ordinary Enter follows native safe-boundary steering
   * when available and otherwise retains the queue fallback.
   */
  busyAgentLabels?: readonly string[];
  busyAgentSteeringMode?: BusyAgentSteeringMode;
  postPending: boolean;
  /** 503 CHANNEL_STORE_UNAVAILABLE — persistent inline banner, input stays live. */
  storeDown: boolean;
  /** 409 CHANNEL_ARCHIVED — composer replaced by a restore bar. */
  archived: boolean;
  onRestore: () => void;
  restorePending: boolean;
}

export const ChannelComposer: React.FC<ChannelComposerProps> = ({
  channelId,
  channelTitle,
  placeholder,
  members,
  onSend,
  busyAgentLabels,
  busyAgentSteeringMode = 'none',
  postPending,
  storeDown,
  archived,
  onRestore,
  restorePending,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineBreakGuardRef = useRef(createLineBreakSubmitGuard());
  // Idempotency (§6.3): one clientMessageId per draft attempt, reused on retry
  // until a send succeeds, so a flaky connection never double-posts.
  const clientIdRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesRef = useRef<PendingImage[]>([]);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [commandPhase, setCommandPhase] = useState<CommandPhase>(null);
  const [selectedCommand, setSelectedCommand] =
    useState<AgentSlashCommandV2 | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const updateImages = useCallback(
    (update: (current: PendingImage[]) => PendingImage[]) => {
      setImages((current) => {
        const next = update(current);
        imagesRef.current = next;
        return next;
      });
    },
    []
  );

  const revokePreview = useCallback((image: PendingImage) => {
    if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  }, []);

  useEffect(
    () => () => {
      for (const image of imagesRef.current) revokePreview(image);
    },
    [revokePreview]
  );

  const uploadImage = useCallback(
    async (image: PendingImage) => {
      updateImages((current) =>
        current.map((entry) => {
          if (entry.localId !== image.localId) return entry;
          const { part: _part, error: _error, ...rest } = entry;
          return { ...rest, status: 'uploading' };
        })
      );
      try {
        const [part] = await uploadChannelImages(channelId, [image.file]);
        if (!part) throw new Error('upload returned no attachment');
        updateImages((current) =>
          current.map((entry) => {
            if (entry.localId !== image.localId) return entry;
            const { error: _error, ...rest } = entry;
            return { ...rest, status: 'ready', part };
          })
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'upload failed';
        updateImages((current) =>
          current.map((entry) => {
            if (entry.localId !== image.localId) return entry;
            const { part: _part, ...rest } = entry;
            return { ...rest, status: 'failed', error: message };
          })
        );
      }
    },
    [channelId, updateImages]
  );

  const addImageFiles = useCallback(
    (files: FileList | readonly File[]) => {
      const candidates = Array.from(files);
      const accepted: File[] = [];
      let error: string | null = null;
      for (const file of candidates) {
        if (!ALLOWED_IMAGE_MIMES.has(file.type)) {
          error = 'unsupported image type — use png, jpeg, webp, or gif';
          continue;
        }
        if (file.size > CHANNEL_COMPOSER_MAX_IMAGE_BYTES) {
          error = `${file.name || 'image'} is too large — max 5mb`;
          continue;
        }
        accepted.push(file);
      }

      const slots = Math.max(
        0,
        CHANNEL_COMPOSER_MAX_IMAGES - imagesRef.current.length
      );
      const selected = accepted.slice(0, slots);
      if (accepted.length > slots) error = 'up to 4 images per message';
      setAttachmentError(error);
      if (selected.length === 0) return;

      const additions = selected.map<PendingImage>((file) => ({
        localId: createBrowserId('attachment'),
        file,
        name: file.name || 'image',
        previewUrl:
          typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : '',
        status: 'uploading',
      }));
      const next = [...imagesRef.current, ...additions];
      imagesRef.current = next;
      setImages(next);
      for (const image of additions) void uploadImage(image);
    },
    [uploadImage]
  );

  const removeImage = useCallback(
    (localId: string) => {
      const target = imagesRef.current.find(
        (image) => image.localId === localId
      );
      if (target) revokePreview(target);
      updateImages((current) =>
        current.filter((image) => image.localId !== localId)
      );
      setAttachmentError(null);
    },
    [revokePreview, updateImages]
  );

  // @mention trigger (#1167). Broader boundary than slash (`(@x`, `hey,@x` are
  // mentions) — see slashTrigger.detectTrigger. Roster is fetched lazily on the
  // first @ per channel and cached 30s; TanStack dedupes with the header query.
  const trigger = detectTrigger(draft, caret, ['@']);
  const rosterQuery = useQuery({
    queryKey: ['channel-roster', channelId],
    queryFn: () => fetchChannelRoster(channelId),
    staleTime: 30_000,
    enabled: trigger !== null,
    retry: false,
  });
  // Memoize on the query string + roster data + members so palette navigation
  // callbacks don't churn on every keystroke that leaves them intact.
  const triggerQuery = trigger?.query ?? null;
  const rosterData = rosterQuery.data;
  const contacts = useMemo(
    () => buildMentionContacts(rosterData ?? [], members ?? []),
    [rosterData, members]
  );
  const entries = useMemo(
    () =>
      triggerQuery === null
        ? []
        : filterMentionContacts(contacts, triggerQuery),
    [triggerQuery, contacts]
  );
  const commandTrigger = useMemo(
    () => detectMentionCommandTrigger(draft, caret, contacts, rosterData ?? []),
    [draft, caret, contacts, rosterData]
  );
  const commandEntries = useMemo(
    () =>
      (commandTrigger?.rosterEntry?.commands ?? []).filter(
        (command) =>
          command.dispatch === 'relay-control' &&
          commandMatches(command, commandTrigger?.commandQuery ?? '')
      ),
    [commandTrigger]
  );
  const commandArgumentRows = useMemo<AgentCommandPaletteRow[]>(() => {
    if (!selectedCommand) return [];
    return (selectedCommand.args ?? [])
      .filter((option) =>
        option.value
          .toLowerCase()
          .startsWith((commandTrigger?.argument ?? '').toLowerCase())
      )
      .map((option) => ({ kind: 'argument', ...option }));
  }, [selectedCommand, commandTrigger?.argument]);
  const commandRows = useMemo<AgentCommandPaletteRow[]>(() => {
    if (commandPhase === 'confirm') {
      return [
        { kind: 'confirm', value: 'confirm' },
        { kind: 'confirm', value: 'cancel' },
      ];
    }
    if (commandPhase === 'arguments') return commandArgumentRows;
    return commandEntries.map((command) => ({ kind: 'command', command }));
  }, [commandArgumentRows, commandEntries, commandPhase]);
  const paletteVisible =
    trigger !== null && !paletteDismissed && entries.length > 0;
  const commandPaletteVisible = commandTrigger !== null && !paletteDismissed;

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 20;
    const maxHeight = lineHeight * 6 + 32;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [draft, resize]);

  // Reset palette selection + reopen it whenever the draft changes (typing after
  // an Escape dismissal re-surfaces the palette).
  useEffect(() => {
    setActiveIndex(0);
    setPaletteDismissed(false);
  }, [draft]);

  // Command intent only survives edits that keep the same exact addressed
  // profile and command token. This prevents a stale profile id executing after
  // a rename, collision-token edit, or moving the caret into ordinary prose.
  useEffect(() => {
    if (!commandTrigger) {
      setCommandPhase(null);
      setSelectedCommand(null);
      return;
    }
    if (
      selectedCommand &&
      commandTrigger.commandQuery &&
      ![selectedCommand.name, ...(selectedCommand.aliases ?? [])].some(
        (name) =>
          name.toLowerCase() === commandTrigger.commandQuery.toLowerCase()
      )
    ) {
      setCommandPhase(null);
      setSelectedCommand(null);
    }
  }, [commandTrigger, selectedCommand]);

  const updateCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }, []);

  // #1308 slice 4 item 2b. `busy` is what turns the bar into a steering cluster;
  // it is derived from the caller's live status signal, never from the draft.
  const busy = (busyAgentLabels?.length ?? 0) > 0;

  const submit = useCallback(
    (steering?: ChannelPostSteering) => {
      const content = draft.trim();
      if (sendingRef.current) return;
      if (images.some((image) => image.status === 'uploading')) {
        setAttachmentError('wait for image uploads to finish');
        return;
      }
      if (images.some((image) => image.status === 'failed')) {
        setAttachmentError('retry or remove failed images before sending');
        return;
      }
      const parts = images.flatMap((image) => (image.part ? [image.part] : []));
      if (!content && parts.length === 0) return;
      const submittedImageIds = new Set(images.map((image) => image.localId));
      const submittedImages = images;
      if (!clientIdRef.current) clientIdRef.current = createBrowserId('chm');
      const clientMessageId = clientIdRef.current;
      sendingRef.current = true;
      void onSend(content, clientMessageId, parts, steering)
        .then(() => {
          // Success: the row arrives via the socket, not this promise. Reset the
          // draft and idempotency key so the next message is a fresh attempt.
          clientIdRef.current = null;
          setDraft('');
          setCaret(0);
          for (const image of submittedImages) revokePreview(image);
          updateImages((current) =>
            current.filter((image) => !submittedImageIds.has(image.localId))
          );
          if (
            imagesRef.current.every((image) =>
              submittedImageIds.has(image.localId)
            )
          ) {
            setAttachmentError(null);
          }
        })
        .catch(() => {
          // Keep the draft AND the same clientMessageId so a retry (press enter
          // again) dedupes server-side instead of double-posting.
        })
        .finally(() => {
          sendingRef.current = false;
        });
    },
    [draft, images, onSend, revokePreview, updateImages]
  );

  // Splice the selected SELECTABLE contact into the draft as plain mention text
  // (no rich pill), replacing the active trigger span. The inserted text
  // round-trips through parseMentions back to this contact's profile Actor id.
  const applyMention = useCallback(() => {
    if (!trigger) return;
    const entry = entries[activeIndex];
    if (!entry || !isMentionContactSelectable(entry)) return;
    const replacement = `${mentionInsertText(entry)} `;
    const newDraft =
      draft.slice(0, trigger.span[0]) +
      replacement +
      draft.slice(trigger.span[1]);
    const newCaret = trigger.span[0] + replacement.length;
    setDraft(newDraft);
    setCaret(newCaret);
    setActiveIndex(0);
    setPaletteDismissed(false);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.selectionStart = newCaret;
        el.selectionEnd = newCaret;
        el.focus();
      }
    });
  }, [trigger, entries, activeIndex, draft]);

  const executeCommand = useCallback(
    (command: AgentSlashCommandV2, args?: string, confirmed = false) => {
      if (!commandTrigger || commandPending) return;
      const normalizedArgs = args?.trim();
      if (command.argumentHint && !normalizedArgs) {
        setCommandStatus(`/${command.name} requires ${command.argumentHint}`);
        setCommandPhase('arguments');
        return;
      }
      // The server independently rejects destructive controls without this
      // acknowledgement. Keep the same invariant in the UI so Enter on a
      // typed argument cannot skip the visible confirmation row.
      if (needsConfirmation(command) && !confirmed) {
        setSelectedCommand(command);
        setCommandPhase('confirm');
        setCommandStatus(
          `confirm /${command.name} for @${commandTrigger.contact.displayName}`
        );
        return;
      }
      setCommandPending(true);
      setCommandStatus(
        `running /${command.name} for @${commandTrigger.contact.displayName}…`
      );
      void executeChannelAgentCommand(channelId, {
        profileId: commandTrigger.contact.id,
        command: command.name,
        ...(normalizedArgs ? { args: normalizedArgs } : {}),
        ...(confirmed ? { confirmed: true } : {}),
      })
        .then(() => {
          setCommandStatus(
            `/${command.name} applied to @${commandTrigger.contact.displayName}`
          );
          setDraft('');
          setCaret(0);
          setCommandPhase(null);
          setSelectedCommand(null);
          setPaletteDismissed(true);
        })
        .catch((error) => {
          const detail =
            error instanceof Error ? error.message : 'command failed';
          setCommandStatus(`/${command.name} failed: ${detail}`);
        })
        .finally(() => setCommandPending(false));
    },
    [channelId, commandPending, commandTrigger]
  );

  const selectCommand = useCallback(
    (command: AgentSlashCommandV2) => {
      if (!commandTrigger) return;
      const replacement = `/${command.name}`;
      const nextDraft =
        draft.slice(
          0,
          commandTrigger.commandStart +
            mentionInsertText(commandTrigger.contact).length
        ) +
        replacement +
        draft.slice(commandTrigger.commandEnd);
      const nextCaret =
        commandTrigger.commandStart +
        mentionInsertText(commandTrigger.contact).length +
        replacement.length;
      setDraft(nextDraft);
      setCaret(nextCaret);
      setActiveIndex(0);
      setSelectedCommand(command);
      if ((command.args?.length ?? 0) > 0 || command.argumentHint) {
        setCommandPhase('arguments');
        setCommandStatus(
          command.args?.length
            ? `choose a value for /${command.name}`
            : `type a value for /${command.name}`
        );
      } else {
        executeCommand(command, commandTrigger.argument);
      }
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.selectionStart = nextCaret;
        el.selectionEnd = nextCaret;
        el.focus();
      });
    },
    [commandTrigger, draft, executeCommand]
  );

  const activateCommandRow = useCallback(
    (index: number) => {
      const row = commandRows[index];
      if (!row) {
        // A typed model name has no enumerated row. Enter confirms it only
        // after the command has already been chosen in the first palette.
        if (
          commandPhase === 'arguments' &&
          selectedCommand &&
          commandTrigger?.argument
        ) {
          executeCommand(selectedCommand, commandTrigger.argument);
        }
        return;
      }
      if (row.kind === 'command') {
        selectCommand(row.command);
        return;
      }
      if (row.kind === 'argument') {
        if (selectedCommand) executeCommand(selectedCommand, row.value);
        return;
      }
      if (row.value === 'cancel') {
        setCommandPhase(null);
        setSelectedCommand(null);
        setCommandStatus('command cancelled');
        return;
      }
      if (selectedCommand) {
        executeCommand(selectedCommand, commandTrigger?.argument, true);
      }
    },
    [
      commandPhase,
      commandRows,
      commandTrigger?.argument,
      executeCommand,
      selectCommand,
      selectedCommand,
    ]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent as KeyboardEvent;
      if (e.key === 'Enter' && nativeEvent.isComposing) return;

      if (commandPaletteVisible) {
        if (e.key === 'ArrowDown' && commandRows.length > 0) {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, commandRows.length - 1));
          return;
        }
        if (e.key === 'ArrowUp' && commandRows.length > 0) {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPaletteDismissed(true);
          setCommandPhase(null);
          setSelectedCommand(null);
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          activateCommandRow(activeIndex);
          return;
        }
      }

      // A command-shaped draft is never a channel message. Escape only hides
      // the preview; pressing Enter again reopens it instead of accidentally
      // posting `@agent/command` through mention routing.
      if (
        commandTrigger !== null &&
        ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')
      ) {
        e.preventDefault();
        setPaletteDismissed(false);
        return;
      }

      if (paletteVisible) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, entries.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setPaletteDismissed(true);
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          const entry = entries[activeIndex];
          if (entry && isMentionContactSelectable(entry)) applyMention();
          // Unselectable/none → no-op: swallow the key so Enter neither sends
          // nor inserts and Tab does not move focus out of the composer.
          return;
        }
      }

      if (e.key === 'Enter' && e.shiftKey) {
        lineBreakGuardRef.current.deferNextLineBreak();
        return;
      }
      lineBreakGuardRef.current.reset();
      if (e.key === 'Enter') {
        e.preventDefault();
        // #1308 slice 4 item 2b. Enter keeps its one meaning (send); the
        // modifier only changes what happens to the agent's LIVE turn, and only
        // while there is one — cmd/ctrl+enter on an idle channel is a plain
        // send, never a silently-different action. No conflict: the composer's
        // own bindings are enter / shift+enter / palette arrows / tab / escape,
        // and no global handler claims cmd+enter.
        if ((e.metaKey || e.ctrlKey) && busy) submit('interrupt');
        else submit();
      }
    },
    [
      commandPaletteVisible,
      commandRows.length,
      activateCommandRow,
      commandTrigger,
      paletteVisible,
      entries,
      activeIndex,
      applyMention,
      busy,
      submit,
    ]
  );

  // Mobile IME parity: some IMEs only report a beforeinput line-break intent for
  // the send key, no reliable keydown. Treat it as send (or, with the palette
  // open, a mention pick) before it mutates the controlled draft.
  const handleBeforeInput = useCallback(
    (inputEvent: InputEvent) => {
      if (!lineBreakGuardRef.current.consumesAsSubmit(inputEvent)) return;
      inputEvent.preventDefault();
      if (commandPaletteVisible) {
        activateCommandRow(activeIndex);
        return;
      }
      if (commandTrigger !== null) {
        setPaletteDismissed(false);
        return;
      }
      if (paletteVisible) {
        const entry = entries[activeIndex];
        if (entry && isMentionContactSelectable(entry)) applyMention();
        return;
      }
      submit();
    },
    [
      commandPaletteVisible,
      activateCommandRow,
      commandTrigger,
      paletteVisible,
      entries,
      activeIndex,
      applyMention,
      submit,
    ]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.addEventListener('beforeinput', handleBeforeInput);
    return () => textarea.removeEventListener('beforeinput', handleBeforeInput);
  }, [handleBeforeInput]);

  const handleImagePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      addImageFiles(files);
    },
    [addImageFiles]
  );

  const handleImageDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      const dropped = e.dataTransfer?.files;
      if (!dropped || dropped.length === 0) return;
      const images = Array.from(dropped).filter((file) =>
        file.type.startsWith('image/')
      );
      if (images.length === 0) return;
      e.preventDefault();
      addImageFiles(images);
    },
    [addImageFiles]
  );

  if (archived) {
    return (
      <div className="ch-composer ch-composer--archived" role="form">
        <div className="ch-composer__archived-bar">
          <span>this channel is archived</span>
          <button
            type="button"
            className="ch-composer__restore"
            onClick={onRestore}
            disabled={restorePending}
          >
            {restorePending ? 'restoring…' : 'restore'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ch-composer" role="form" aria-label="message composer">
      {storeDown ? (
        <div className="ch-composer__banner" role="alert">
          channel store unavailable — retry shortly
        </div>
      ) : null}
      <div className="ch-composer__mention-anchor">
        <AgentCommandPalette
          rows={commandRows}
          activeIndex={activeIndex}
          visible={commandPaletteVisible}
          disabled={commandPending}
          label={`commands for ${commandTrigger?.contact.displayName ?? 'agent'}`}
          emptyMessage={
            commandPhase === 'arguments' && selectedCommand
              ? commandTrigger?.argument
                ? `press enter to use “${commandTrigger.argument}”`
                : `type ${selectedCommand.argumentHint ?? 'a value'}`
              : commandPending
                ? 'applying command…'
                : 'no commands available for this agent'
          }
          onSelect={activateCommandRow}
        />
        <MentionPalette
          contacts={entries}
          activeIndex={activeIndex}
          visible={paletteVisible}
        />
        <textarea
          ref={textareaRef}
          className="ch-composer__ta"
          placeholder={
            placeholder ??
            `message #${channelTitle}…  ·  @ to mention · shift+enter for newline`
          }
          value={draft}
          rows={1}
          enterKeyHint="send"
          aria-label="message input"
          aria-controls={
            commandPaletteVisible ? 'channel-agent-command-palette' : undefined
          }
          aria-expanded={commandPaletteVisible}
          aria-activedescendant={
            commandPaletteVisible && commandRows.length > 0
              ? `channel-agent-command-option-${activeIndex}`
              : undefined
          }
          data-pending={postPending ? 'true' : 'false'}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setCaret(event.currentTarget.selectionStart ?? 0);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={updateCaret}
          onClick={updateCaret}
          onSelect={updateCaret}
          onPaste={handleImagePaste}
          onDrop={handleImageDrop}
          onDragOver={(e) => e.preventDefault()}
        />
      </div>
      <div className="ch-composer__command-status" aria-live="polite">
        {commandStatus}
      </div>
      {images.length > 0 ? (
        <div
          className="ch-composer__attachments"
          aria-label="image attachments"
        >
          {images.map((image) => (
            <span
              key={image.localId}
              className={`ch-composer__attachment ch-composer__attachment--${image.status}`}
              title={image.error ?? image.name}
            >
              {image.previewUrl ? (
                <img
                  className="ch-composer__attachment-thumb"
                  src={image.previewUrl}
                  alt=""
                />
              ) : null}
              <span className="ch-composer__attachment-name">{image.name}</span>
              <span className="ch-composer__attachment-status" role="status">
                {image.status === 'uploading'
                  ? 'uploading…'
                  : image.status === 'failed'
                    ? 'failed'
                    : 'ready'}
              </span>
              {image.status === 'failed' ? (
                <button
                  type="button"
                  className="ch-composer__attachment-retry"
                  onClick={() => void uploadImage(image)}
                >
                  retry
                </button>
              ) : null}
              <button
                type="button"
                className="ch-composer__attachment-remove"
                aria-label={`remove ${image.name}`}
                onClick={() => removeImage(image.localId)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attachmentError ? (
        <div className="ch-composer__attachment-error" role="alert">
          {attachmentError}
        </div>
      ) : null}
      <div className="ch-composer__bar">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(event) => {
            if (event.currentTarget.files)
              addImageFiles(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
        <button
          type="button"
          className="ch-composer__attach"
          aria-label="attach image"
          title="attach image"
          disabled={images.length >= CHANNEL_COMPOSER_MAX_IMAGES}
          onClick={() => fileInputRef.current?.click()}
        >
          +img
        </button>
        {busy ? (
          // Mid-turn steering cluster. The default follows the harness's own
          // safe-boundary primitive when supported; legacy harnesses keep the
          // FIFO queue. The second action cancels the live turn first. It reuses the header chip's
          // interrupt glyph — the black square is already the one interrupt
          // vocabulary in the product — with danger-tinted chrome so the
          // destructive member of the pair reads differently at rest.
          <span
            className="ch-composer__steer"
            role="group"
            aria-label="mid-turn steering"
          >
            <button
              type="button"
              className="ch-composer__steer-btn"
              onClick={() => submit()}
              title={defaultSendHint(
                busyAgentLabels ?? [],
                busyAgentSteeringMode
              )}
            >
              {defaultSendLabel(busyAgentSteeringMode)}
            </button>
            <button
              type="button"
              className="ch-composer__steer-btn ch-composer__steer-btn--interrupt"
              onClick={() => submit('interrupt')}
              aria-label="interrupt and send"
              title="interrupt and send"
            >
              <span aria-hidden="true">■</span> interrupt &amp; send
            </button>
          </span>
        ) : null}
        <span className="ch-composer__hint">
          {busy ? (
            <>
              <kbd>↵</kbd>
              {busyAgentSteeringMode === 'all'
                ? 'steer after tool'
                : busyAgentSteeringMode === 'some'
                  ? 'steer / queue'
                  : 'queue'}{' '}
              <kbd>⌘↵</kbd>interrupt <kbd>⇧↵</kbd>newline
            </>
          ) : (
            <>
              <kbd>↵</kbd>send <kbd>⇧↵</kbd>newline <kbd>@</kbd>mention
            </>
          )}
        </span>
      </div>
    </div>
  );
};

export default ChannelComposer;
