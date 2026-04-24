import React, { useRef } from 'react';
import ReactDOM from 'react-dom/client';
import Terminal, { type TerminalHandle } from './components/Terminal.js';
import './App.css';
import './test-terminal.css';

function TerminalHarness() {
  const terminalRef = useRef<TerminalHandle | null>(null);

  function writeScrollback() {
    const term = terminalRef.current?.getTerm();
    if (!term) return;
    for (let i = 0; i < 160; i += 1) {
      term.writeln(`viewport lock regression line ${i}`);
    }
  }

  return (
    <div className="terminal-test-page">
      <div className="terminal-test-controls">
        <button type="button" onClick={() => terminalRef.current?.focusTerm()}>
          focus
        </button>
        <button type="button" onClick={() => terminalRef.current?.fitTerm()}>
          fit
        </button>
        <button type="button" onClick={writeScrollback}>
          write scrollback
        </button>
      </div>
      <div className="terminal-test-frame">
        <Terminal
          ref={terminalRef}
          sessionId={null}
          useTmux={true}
          onCopyModeChange={() => undefined}
          onFilePathClick={() => undefined}
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <TerminalHarness />
  </React.StrictMode>
);
