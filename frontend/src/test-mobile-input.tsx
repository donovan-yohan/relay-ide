import React, { useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { MobileInput } from './components/MobileInput.js';
import type { MobileInputHandle } from './components/MobileInput.js';
import './components/MobileInput.css';

function TestPage() {
  const mobileInputRef = useRef<MobileInputHandle>(null);
  const [debugState, setDebugState] = useState('default');

  const enableDevtools = () => {
    localStorage.setItem('devtools-enabled', 'true');
    window.dispatchEvent(new Event('devtools-changed'));
    setDebugState('devtools enabled');
  };

  const disableDevtools = () => {
    localStorage.setItem('devtools-enabled', 'false');
    window.dispatchEvent(new Event('devtools-changed'));
    setDebugState('devtools disabled');
  };

  const triggerFocus = () => {
    mobileInputRef.current?.focus();
    setDebugState('focus requested');
  };

  const triggerClear = () => {
    mobileInputRef.current?.clearInput();
    setDebugState('input cleared');
  };

  return (
    <div className="test-page">
      <div className="test-section" id="test-container">
        <h2>MobileInput — debug states</h2>
        <p style={{ color: '#888', fontSize: 12 }}>
          Note: MobileInput only renders on mobile devices (touch + Android/iOS user agent).
          State: {debugState}
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button
            onClick={enableDevtools}
            style={{ padding: '6px 12px', background: '#333', color: '#0f0', border: '1px solid #555', cursor: 'pointer', fontSize: 12 }}
          >
            enable devtools
          </button>
          <button
            onClick={disableDevtools}
            style={{ padding: '6px 12px', background: '#333', color: '#888', border: '1px solid #555', cursor: 'pointer', fontSize: 12 }}
          >
            disable devtools
          </button>
          <button
            onClick={triggerFocus}
            style={{ padding: '6px 12px', background: '#333', color: '#fff', border: '1px solid #555', cursor: 'pointer', fontSize: 12 }}
          >
            focus input
          </button>
          <button
            onClick={triggerClear}
            style={{ padding: '6px 12px', background: '#333', color: '#fff', border: '1px solid #555', cursor: 'pointer', fontSize: 12 }}
          >
            clear input
          </button>
        </div>

        <div style={{ color: '#555', fontSize: 11, marginTop: 8 }}>
          The hidden mobile input form is rendered below (only visible on mobile UA):
        </div>
        <MobileInput ref={mobileInputRef} />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <TestPage />
  </React.StrictMode>
);
