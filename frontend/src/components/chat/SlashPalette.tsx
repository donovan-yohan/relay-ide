import React from 'react';
import type {
  AgentCapabilitySetV2,
  AgentSlashCommandV2,
} from '../../../../shared/agent-chat-protocol-v2.js';
import { detectSlashTrigger } from './slashTrigger.js';

interface FallbackSlashCommand {
  command: string;
  description: string;
  shortcut: string;
  capability?: keyof AgentCapabilitySetV2;
  aliases?: string[];
}

const FALLBACK_COMMANDS: FallbackSlashCommand[] = [
  {
    command: '/clear',
    description: 'drop the current turn history',
    shortcut: '⌘L',
    aliases: ['/reset', '/new'],
  },
  {
    command: '/resume',
    description: 're-attach last interrupted turn',
    shortcut: '⌘R',
    capability: 'resume',
    aliases: ['/continue'],
  },
  { command: '/model', description: 'switch model', shortcut: '⌘M' },
  {
    command: '/compact',
    description: 'compact context',
    shortcut: '',
    capability: 'compact',
  },
];

/** A command row returned from useSlashCommands for display in the palette. */
export interface DisplayCommand {
  command: string;
  description: string;
  shortcut: string;
  argumentHint?: string;
  /** Substrings of `command` (excluding prefix char) that match the query. */
  matchSpans?: [number, number][];
  /** Source group for grouping in empty-query view. */
  source?: AgentSlashCommandV2['source'];
  /** Human label for the source group. */
  sourceLabel?: string;
}

interface SearchableCommand extends DisplayCommand {
  aliases?: string[];
}

function nameToCommand(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('/') || trimmed.startsWith('$') ? trimmed : `/${trimmed}`;
}

/** Compute match spans for `query` inside `text` (case-insensitive). Returns empty array if no match. */
function computeMatchSpans(text: string, query: string): [number, number][] {
  if (!query) return [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return [];
  return [[idx, idx + q.length]];
}

function deriveCommands(
  capabilities: AgentCapabilitySetV2,
  fromSdk?: AgentSlashCommandV2[]
): SearchableCommand[] {
  if (fromSdk && fromSdk.length > 0) {
    const byCommand = new Map<string, SearchableCommand>();

    for (const entry of fromSdk) {
      const command = nameToCommand(entry.name);
      const key = command.toLowerCase();
      if (byCommand.has(key)) continue;

      byCommand.set(key, {
        command,
        description: entry.description ?? '',
        shortcut: '',
        ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
        ...(entry.aliases && entry.aliases.length > 0
          ? { aliases: entry.aliases.map(nameToCommand) }
          : {}),
        ...(entry.source !== undefined ? { source: entry.source } : {}),
        ...(entry.sourceLabel !== undefined ? { sourceLabel: entry.sourceLabel } : {}),
      });
    }

    return [...byCommand.values()];
  }

  return FALLBACK_COMMANDS.filter(
    (entry) =>
      entry.capability === undefined ||
      capabilities[entry.capability] === true
  ).map((entry) => ({
    command: entry.command,
    description: entry.description,
    shortcut: entry.shortcut,
    ...(entry.aliases ? { aliases: entry.aliases } : {}),
  }));
}

/**
 * Filter and score slash commands using the two-pass scoring algorithm (§4.3).
 *
 * Signature: useSlashCommands(capabilities, text, caret, commands?)
 *
 * Returns empty array when:
 * - slashCommands capability is not enabled
 * - detectSlashTrigger returns null at the given caret position
 */
export function useSlashCommands(
  capabilities: AgentCapabilitySetV2,
  text: string,
  caret: number,
  commands?: AgentSlashCommandV2[]
): DisplayCommand[] {
  if (capabilities.slashCommands !== true) return [];

  const trigger = detectSlashTrigger(text, caret);
  if (!trigger) return [];

  const query = trigger.query.toLowerCase();
  const all = deriveCommands(capabilities, commands);

  // Empty query → full catalog, grouped by source (no scoring needed)
  if (query.length === 0) {
    return all.map(({ aliases: _aliases, ...entry }) => entry);
  }

  // Two-pass scoring (§4.3)
  // Tier 1: name or alias startsWith query
  // Tier 2: name or alias includes query (not tier 1)
  // Tier 3: description includes query (not tier 1 or 2)

  const tier1: DisplayCommand[] = [];
  const tier2: DisplayCommand[] = [];
  const tier3: DisplayCommand[] = [];

  for (const entry of all) {
    const cmdCore = entry.command.replace(/^[/$]/, '').toLowerCase();
    const aliases = (entry.aliases ?? []).map((a) => a.replace(/^[/$]/, '').toLowerCase());
    const allNames = [cmdCore, ...aliases];
    const descLower = entry.description.toLowerCase();

    const nameStartsMatch = allNames.some((n) => n.startsWith(query));
    const nameIncludesMatch = !nameStartsMatch && allNames.some((n) => n.includes(query));
    const descMatch = !nameStartsMatch && !nameIncludesMatch && descLower.includes(query);

    if (!nameStartsMatch && !nameIncludesMatch && !descMatch) continue;

    // Compute match spans against the canonical command name (excluding prefix char)
    const matchSpans = computeMatchSpans(cmdCore, query);

    const row: DisplayCommand = {
      command: entry.command,
      description: entry.description,
      shortcut: entry.shortcut,
      ...(matchSpans.length > 0 ? { matchSpans } : {}),
      ...(entry.source !== undefined ? { source: entry.source } : {}),
      ...(entry.sourceLabel !== undefined ? { sourceLabel: entry.sourceLabel } : {}),
      ...(entry.argumentHint !== undefined ? { argumentHint: entry.argumentHint } : {}),
    };

    if (nameStartsMatch) {
      tier1.push(row);
    } else if (nameIncludesMatch) {
      tier2.push(row);
    } else {
      tier3.push(row);
    }
  }

  return [...tier1, ...tier2, ...tier3];
}

interface SlashPaletteProps {
  commands: DisplayCommand[];
  activeIndex: number;
  visible: boolean;
}

export const SlashPalette: React.FC<SlashPaletteProps> = ({
  commands,
  activeIndex,
  visible,
}) => {
  // When empty query, group by source. When filtered, render flat.
  const hasMatchSpans = commands.some((c) => c.matchSpans !== undefined);
  const hasSourceGroups = !hasMatchSpans && commands.some((c) => c.source !== undefined);

  if (hasSourceGroups) {
    // Group by source
    const groups = new Map<string, DisplayCommand[]>();
    for (const cmd of commands) {
      const key = cmd.source ?? 'other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(cmd);
    }

    let flatIndex = 0;
    const sections: React.ReactNode[] = [];
    for (const [, groupCmds] of groups) {
      const firstCmd = groupCmds[0];
      const groupLabel = firstCmd?.sourceLabel ?? firstCmd?.source ?? 'other';
      sections.push(
        <div key={groupLabel} className="slash__group">
          {groupLabel}
        </div>
      );
      for (const entry of groupCmds) {
        const idx = flatIndex++;
        sections.push(
          <SlashPaletteRow key={entry.command} entry={entry} active={idx === activeIndex} />
        );
      }
    }

    return (
      <div
        className="slash"
        role="listbox"
        style={{ display: visible ? undefined : 'none' }}
      >
        {sections}
      </div>
    );
  }

  return (
    <div
      className="slash"
      role="listbox"
      style={{ display: visible ? undefined : 'none' }}
    >
      {commands.map((entry, index) => (
        <SlashPaletteRow
          key={entry.command}
          entry={entry}
          active={index === activeIndex}
        />
      ))}
    </div>
  );
};

/** Render command name with matched substrings highlighted using <mark>. */
function renderHighlightedName(
  command: string,
  matchSpans: [number, number][] | undefined
): React.ReactNode {
  // command is like "/review" — highlight inside the name part (after prefix char)
  const prefix = command[0];
  const name = command.slice(1);

  if (!matchSpans || matchSpans.length === 0) {
    return (
      <>
        <span className="slash__cmd-prefix">{prefix}</span>
        {name}
      </>
    );
  }

  const parts: React.ReactNode[] = [<span key="prefix" className="slash__cmd-prefix">{prefix}</span>];
  let cursor = 0;
  for (const [start, end] of matchSpans) {
    if (start > cursor) parts.push(name.slice(cursor, start));
    parts.push(<mark key={`m${start}`} className="slash__match">{name.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < name.length) parts.push(name.slice(cursor));
  return <>{parts}</>;
}

const SlashPaletteRow: React.FC<{
  entry: DisplayCommand;
  active: boolean;
}> = ({ entry, active }) => {
  const detail = `${entry.description}${entry.argumentHint ? ` ${entry.argumentHint}` : ''}`;

  return (
    <div
      className={`slash__row${active ? ' slash__row--active' : ''}`}
      role="option"
      aria-selected={active}
    >
      <span className="slash__cmd" title={entry.command}>
        {renderHighlightedName(entry.command, entry.matchSpans)}
      </span>
      <span className="slash__desc" title={detail}>
        {detail}
      </span>
      <span className="slash__sc">{entry.shortcut}</span>
    </div>
  );
};

export default SlashPalette;
