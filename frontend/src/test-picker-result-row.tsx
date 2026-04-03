import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { PickerResultRow } from './components/PickerResultRow.js';
import type { SessionIntent } from './lib/session-intent.js';
import './components/PickerResultRow.css';
import './components/StatusDot.css';
import './components/TuiButton.css';

const intentOpen: SessionIntent = {
  type: 'open-branch',
  label: 'Open',
  color: 'accent',
  prompt: 'Open branch',
};

const intentReview: SessionIntent = {
  type: 'review-pr',
  label: 'Review',
  color: 'info',
  prompt: 'Review PR',
};

const intentResume: SessionIntent = {
  type: 'resume-session',
  label: 'Resume',
  color: 'muted',
  prompt: null,
};

function TestPage() {
  const [lastAction, setLastAction] = useState('');

  const handleSelectIntent = (intent: SessionIntent) => {
    setLastAction('intent: ' + intent.type);
  };

  return (
    <div className="test-page">
      <div className="test-section" id="test-container">
        <h2>PickerResultRow — variants</h2>
        <div id="action-log" style={{ marginBottom: 16, color: '#888', fontSize: 12 }}>
          {lastAction || '(no action)'}
        </div>

        <div style={{ border: '1px solid #333', marginBottom: 8 }}>
          <PickerResultRow
            label="feat/my-branch"
            intents={[intentOpen]}
            onSelectIntent={handleSelectIntent}
          />
        </div>

        <div style={{ border: '1px solid #333', marginBottom: 8 }}>
          <PickerResultRow
            label="feat/with-sublabel"
            sublabel="2 commits ahead"
            dotStatus="open"
            intents={[intentOpen]}
            onSelectIntent={handleSelectIntent}
          />
        </div>

        <div style={{ border: '1px solid #333', marginBottom: 8 }}>
          <PickerResultRow
            label="feat/focused-row"
            sublabel="focused state"
            dotStatus="review-requested"
            intents={[intentReview]}
            focused={true}
            onSelectIntent={handleSelectIntent}
          />
        </div>

        <div style={{ border: '1px solid #333', marginBottom: 8 }}>
          <PickerResultRow
            label="feat/multiple-intents"
            sublabel="primary + secondary"
            dotStatus="changes-requested"
            intents={[intentOpen, intentReview, intentResume]}
            onSelectIntent={handleSelectIntent}
          />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <TestPage />
  </React.StrictMode>
);
