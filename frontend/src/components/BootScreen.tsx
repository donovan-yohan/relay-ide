import React from 'react';
import './BootScreen.css';

export type BootState = 'loading' | 'error' | 'ready';

export interface BootScreenProps {
  state?: BootState;
  statusText?: string;
  errorMessage?: string;
  appName?: string;
}

export function BootScreen({
  state = 'loading',
  statusText = 'Connecting...',
  errorMessage,
  appName = 'claude-remote',
}: BootScreenProps) {
  return (
    <div className="boot-screen" role="status" aria-live="polite">
      <div className="boot-screen__logo">{appName}</div>

      {state === 'loading' ? (
        <>
          <div className="boot-screen__status">{statusText}</div>
          <div className="boot-screen__progress" aria-hidden="true">
            <span className="boot-screen__dot" />
            <span className="boot-screen__dot" />
            <span className="boot-screen__dot" />
          </div>
        </>
      ) : state === 'error' ? (
        <div className="boot-screen__error">
          <div>{errorMessage ?? 'Connection failed.'}</div>
          <div className="boot-screen__error-code">Check server is running and refresh.</div>
        </div>
      ) : null}
    </div>
  );
}

export default BootScreen;
