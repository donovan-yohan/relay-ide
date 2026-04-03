import React, { useState } from 'react';
import { useAuthStore } from '../lib/stores/auth.js';
import { TuiButton } from './TuiButton.js';
import { TuiInput } from './TuiInput.js';
import './PinGate.css';

const PIN_INPUT_PROPS = { type: 'password' as const, inputMode: 'numeric' as const, maxLength: 20 };

interface SetupFormProps {
  pinValue: string;
  confirmValue: string;
  onPinChange: (v: string) => void;
  onConfirmChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
}

function SetupForm({ pinValue, confirmValue, onPinChange, onConfirmChange, onKeyDown, onSubmit }: SetupFormProps) {
  return (
    <>
      <p>set up a PIN to secure this instance</p>
      <TuiInput {...PIN_INPUT_PROPS} value={pinValue} onChange={onPinChange} onKeyDown={onKeyDown} placeholder="choose a PIN" autoFocus={true} />
      <TuiInput {...PIN_INPUT_PROPS} value={confirmValue} onChange={onConfirmChange} onKeyDown={onKeyDown} placeholder="confirm PIN" />
      <TuiButton variant="primary" onClick={onSubmit}>set PIN</TuiButton>
    </>
  );
}

interface UnlockFormProps {
  pinValue: string;
  onPinChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
}

function UnlockForm({ pinValue, onPinChange, onKeyDown, onSubmit }: UnlockFormProps) {
  return (
    <>
      <p>enter PIN to continue</p>
      <TuiInput {...PIN_INPUT_PROPS} value={pinValue} onChange={onPinChange} onKeyDown={onKeyDown} placeholder="PIN" autoFocus={true} />
      <TuiButton variant="primary" onClick={onSubmit}>unlock</TuiButton>
      <p className="hint">
        forgot your PIN? run <code>claude-remote-cli pin reset</code> on the host machine
      </p>
    </>
  );
}

function useSetupHandler(
  pinValue: string,
  confirmValue: string,
  setLocalError: (e: string) => void,
  setConfirmValue: (v: string) => void,
  setPinValue: (v: string) => void,
  setupNewPin: (pin: string, confirm: string) => Promise<void>,
  pinError: string | null
) {
  return async () => {
    setLocalError('');
    const pin = pinValue.trim();
    const confirm = confirmValue.trim();
    if (!pin || !confirm) { setLocalError('enter a PIN and confirm it'); return; }
    if (pin.length < 4) { setLocalError('PIN must be at least 4 characters'); return; }
    if (pin !== confirm) { setLocalError('PINs do not match'); setConfirmValue(''); return; }
    await setupNewPin(pin, confirm);
    if (pinError) { setPinValue(''); setConfirmValue(''); }
  };
}

export function PinGate() {
  const { needsSetup, pinError, submitPin, setupNewPin } = useAuthStore();
  const [pinValue, setPinValue] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const [localError, setLocalError] = useState('');
  const displayError = pinError || localError;

  const handleUnlock = async () => {
    setLocalError('');
    const pin = pinValue.trim();
    if (!pin) return;
    await submitPin(pin);
    if (pinError) setPinValue('');
  };

  const handleSetup = useSetupHandler(pinValue, confirmValue, setLocalError, setConfirmValue, setPinValue, setupNewPin, pinError);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { if (needsSetup) { handleSetup(); } else { handleUnlock(); } }
  };

  return (
    <div className="pin-gate">
      <div className="pin-container">
        <h1>Relay</h1>
        {needsSetup
          ? <SetupForm pinValue={pinValue} confirmValue={confirmValue} onPinChange={setPinValue} onConfirmChange={setConfirmValue} onKeyDown={handleKeyDown} onSubmit={handleSetup} />
          : <UnlockForm pinValue={pinValue} onPinChange={setPinValue} onKeyDown={handleKeyDown} onSubmit={handleUnlock} />
        }
        {displayError && <p className="error">{displayError}</p>}
      </div>
    </div>
  );
}

export default PinGate;
