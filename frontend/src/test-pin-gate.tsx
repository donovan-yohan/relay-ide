import React from 'react';
import ReactDOM from 'react-dom/client';
import { PinGate } from './components/PinGate.js';
import useAuthStore from './lib/stores/auth.js';
import './components/PinGate.css';
import './components/TuiButton.css';
import './components/TuiInput.css';

function TestPage() {
  const setUnlockMode = () => {
    useAuthStore.setState({
      needsSetup: false,
      pinError: null,
      checking: false,
      authenticated: false,
    });
  };

  const setSetupMode = () => {
    useAuthStore.setState({
      needsSetup: true,
      pinError: null,
      checking: false,
      authenticated: false,
    });
  };

  const setErrorMode = () => {
    useAuthStore.setState({
      needsSetup: false,
      pinError: 'incorrect PIN',
      checking: false,
      authenticated: false,
    });
  };

  return (
    <div className="test-page">
      <div
        style={{
          position: 'fixed',
          top: 8,
          right: 8,
          display: 'flex',
          gap: 8,
          zIndex: 1000,
        }}
      >
        <button
          onClick={setUnlockMode}
          style={{ padding: '4px 8px', fontSize: 12, cursor: 'pointer', background: '#333', color: '#fff', border: '1px solid #555' }}
        >
          unlock mode
        </button>
        <button
          onClick={setSetupMode}
          style={{ padding: '4px 8px', fontSize: 12, cursor: 'pointer', background: '#333', color: '#fff', border: '1px solid #555' }}
        >
          setup mode
        </button>
        <button
          onClick={setErrorMode}
          style={{ padding: '4px 8px', fontSize: 12, cursor: 'pointer', background: '#333', color: '#fff', border: '1px solid #555' }}
        >
          error mode
        </button>
      </div>

      <div id="test-container">
        <PinGate />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <TestPage />
  </React.StrictMode>
);
