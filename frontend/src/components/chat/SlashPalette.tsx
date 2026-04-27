import React from 'react';
import type { AgentCapabilitySetV2 } from '../../../../shared/agent-chat-protocol-v2.js';

interface SlashPaletteProps {
  capabilities: AgentCapabilitySetV2;
  draft: string;
}

interface SlashCommand {
  group: string;
  command: string;
  description: string;
  shortcut: string;
  capability?: keyof AgentCapabilitySetV2;
}

const BASE_COMMANDS: SlashCommand[] = [
  {
    group: 'session',
    command: '/clear',
    description: 'drop the current turn history',
    shortcut: '⌘L',
  },
  {
    group: 'session',
    command: '/resume',
    description: 're-attach last interrupted turn',
    shortcut: '⌘R',
    capability: 'resume',
  },
  {
    group: 'session',
    command: '/model',
    description: 'switch claude model',
    shortcut: '⌘M',
  },
  {
    group: 'tools',
    command: '/skill',
    description: 'load a skill from the skills directory',
    shortcut: '',
  },
  {
    group: 'tools',
    command: '/compact',
    description: 'compact context',
    shortcut: '',
    capability: 'compact',
  },
];

export const SlashPalette: React.FC<SlashPaletteProps> = ({
  capabilities,
  draft,
}) => {
  if (capabilities.slashCommands !== true) return null;

  const query = draft.startsWith('/') ? draft.slice(1).toLowerCase() : '';
  const commands = BASE_COMMANDS.filter((entry) => {
    if (entry.capability && capabilities[entry.capability] !== true)
      return false;
    return query.length === 0 || entry.command.slice(1).includes(query);
  });
  const visible = draft.startsWith('/');
  let lastGroup = '';

  return (
    <div
      className="slash"
      role="listbox"
      style={{ display: visible ? undefined : 'none' }}
    >
      {commands.map((entry, index) => {
        const showGroup = entry.group !== lastGroup;
        lastGroup = entry.group;
        return (
          <React.Fragment key={entry.command}>
            {showGroup && <div className="slash__group">{entry.group}</div>}
            <div
              className={`slash__row${index === 0 ? ' slash__row--active' : ''}`}
              role="option"
              aria-selected={index === 0}
            >
              <span className="slash__cmd">{entry.command}</span>
              <span className="slash__desc">{entry.description}</span>
              <span className="slash__sc">{entry.shortcut}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default SlashPalette;
