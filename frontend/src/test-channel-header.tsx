import React from 'react';
import ReactDOM from 'react-dom/client';
import './App.css';
import './components/chat/ChannelView.css';

export const DESIGNATION_ERROR =
  'channel already has a non-orchestrator agent bound';

function Fixture(): React.ReactElement {
  return (
    <div className="ch-view">
      <div className="ch-header" data-testid="channel-header">
        <span className="ch-header__title">#operator lane</span>
        <span className="ch-header__meta">· 2 members</span>
        <span className="ch-header__agents" aria-label="active agents">
          <span className="ch-agent-chip ch-agent-chip--idle">
            <span className="ch-agent-chip__dot" aria-hidden="true" />
            <span className="ch-agent-chip__name">claude</span>
          </span>
        </span>
        <button type="button" className="ch-designate-orchestrator">
          designate orchestrator
        </button>
        <span className="ch-designate-orchestrator__error" role="alert">
          {DESIGNATION_ERROR}
        </span>
        <span className="ch-header__spacer" />
        <span
          className="ch-conn-dot ch-conn-dot--on"
          title="connected"
          aria-label="connected"
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(<Fixture />);
