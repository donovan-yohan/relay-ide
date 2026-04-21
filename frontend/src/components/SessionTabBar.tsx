import React, { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../lib/types.js';
import './SessionTabBar.css';

export interface SessionTabBarProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewAgent: () => void;
  onNewTerminal: () => void;
  onCustomize: () => void;
  hidden?: boolean;
}

const terminalSvg = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" width="14" height="14">
    <path d="M4 17l6-6-6-6" /><path d="M12 19h8" />
  </svg>
);

const agentSvg = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" width="14" height="14">
    <rect x="3" y="3" width="18" height="18" /><path d="M3 9h18" /><path d="M9 21V9" />
  </svg>
);

const customizeSvg = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" width="14" height="14">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51V15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

interface NewMenuProps {
  onNewAgent: () => void;
  onNewTerminal: () => void;
  onCustomize: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

function NewMenu({ onNewAgent, onNewTerminal, onCustomize, onKeyDown }: NewMenuProps) {
  return (
    <div className="new-menu" role="menu" tabIndex={-1} onKeyDown={onKeyDown}>
      <button className="new-menu-item" role="menuitem" data-track="session-tab.new-agent" onClick={onNewAgent} type="button">
        <span className="new-menu-icon">{agentSvg}</span>New Agent
      </button>
      <button className="new-menu-item" role="menuitem" data-track="session-tab.new-terminal" onClick={onNewTerminal} type="button">
        <span className="new-menu-icon">{terminalSvg}</span>New Terminal
      </button>
      <div className="new-menu-divider" />
      <button className="new-menu-item" role="menuitem" data-track="session-tab.customize" onClick={onCustomize} type="button">
        <span className="new-menu-icon">{customizeSvg}</span>Customize...
      </button>
    </div>
  );
}

interface TabProps {
  session: SessionSummary;
  tabName: string;
  isActive: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
  onCloseKeyDown: (e: React.KeyboardEvent) => void;
}

function SessionTab({ session, tabName, isActive, onSelect, onClose, onCloseKeyDown }: TabProps) {
  const icon = session.type === 'terminal' ? terminalSvg : agentSvg;
  return (
    <button
      className={['tab', isActive && 'tab--active'].filter(Boolean).join(' ')}
      role="tab" aria-selected={isActive} aria-label={tabName}
      tabIndex={isActive ? 0 : -1} data-track="session-tab.select"
      onClick={onSelect} type="button"
    >
      <span className="tab-icon" aria-hidden="true">{icon}</span>
      <span className="tab-name">{tabName}</span>
      <span className="tab-close" role="button" aria-label={`Close ${tabName}`}
        data-track="session-tab.close" onClick={onClose} onKeyDown={onCloseKeyDown}>
        &times;
      </span>
    </button>
  );
}

export function SessionTabBar({ sessions, activeSessionId, onSelectSession, onCloseSession, onNewAgent, onNewTerminal, onCustomize, hidden = false }: SessionTabBarProps) {
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [tabNames, setTabNames] = useState<Map<string, string>>(new Map());
  const nextAgentIndexRef = useRef(0);
  const nextTerminalIndexRef = useRef(0);
  const newMenuBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTabNames((prev) => {
      const updated = new Map(prev);
      let changed = false;
      for (const s of sessions) {
        if (!updated.has(s.id)) {
          if (s.type === 'terminal') {
            nextTerminalIndexRef.current += 1;
            updated.set(s.id, `Terminal ${nextTerminalIndexRef.current}`);
          } else {
            nextAgentIndexRef.current += 1;
            updated.set(s.id, `Agent ${nextAgentIndexRef.current}`);
          }
          changed = true;
        }
      }
      return changed ? updated : prev;
    });
  }, [sessions]);

  useEffect(() => {
    if (!newMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const wrap = newMenuBtnRef.current?.closest('.new-btn-wrap');
      if (e.target && wrap && !wrap.contains(e.target as Node)) setNewMenuOpen(false);
    };
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [newMenuOpen]);

  const onMenuKeydown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && newMenuOpen) { setNewMenuOpen(false); newMenuBtnRef.current?.focus(); }
  };

  return (
    <div className={`session-tab-bar${hidden ? ' hidden' : ''}`} role="tablist" aria-label="Sessions">
      <div className="tabs-scroll">
        {sessions.map((session) => (
          <SessionTab
            key={session.id}
            session={session}
            tabName={tabNames.get(session.id) ?? session.id}
            isActive={session.id === activeSessionId}
            onSelect={() => onSelectSession(session.id)}
            onClose={(e) => { e.stopPropagation(); onCloseSession(session.id); }}
            onCloseKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onCloseSession(session.id); } }}
          />
        ))}
      </div>
      <div className="new-btn-wrap">
        <button ref={newMenuBtnRef} className="tab-new" aria-label="New session" aria-haspopup="menu"
          aria-expanded={newMenuOpen} data-track="session-tab.new-menu"
          onClick={() => setNewMenuOpen((v) => !v)} onKeyDown={onMenuKeydown} type="button">+</button>
        {newMenuOpen ? (
          <NewMenu
            onNewAgent={() => { setNewMenuOpen(false); onNewAgent(); }}
            onNewTerminal={() => { setNewMenuOpen(false); onNewTerminal(); }}
            onCustomize={() => { setNewMenuOpen(false); onCustomize(); }}
            onKeyDown={onMenuKeydown}
          />
        ) : null}
      </div>
    </div>
  );
}

export default SessionTabBar;
