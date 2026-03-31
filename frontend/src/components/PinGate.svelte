<script lang="ts">
  import { getAuth, submitPin, setupNewPin } from '../lib/state/auth.svelte.js';
  import TuiButton from './TuiButton.svelte';
  import PinInput from './PinInput.svelte';

  const auth = getAuth();
  let pinValue = $state('');
  let confirmValue = $state('');
  let localError = $state('');

  async function handleUnlock() {
    localError = '';
    const pin = pinValue.trim();
    if (!pin) return;
    await submitPin(pin);
    if (auth.pinError) {
      pinValue = '';
    }
  }

  async function handleSetup() {
    localError = '';
    const pin = pinValue.trim();
    const confirm = confirmValue.trim();
    if (!pin || !confirm) {
      localError = 'enter a PIN and confirm it';
      return;
    }
    if (pin.length < 4) {
      localError = 'PIN must be at least 4 characters';
      return;
    }
    if (pin !== confirm) {
      localError = 'PINs do not match';
      confirmValue = '';
      return;
    }
    await setupNewPin(pin, confirm);
    if (auth.pinError) {
      pinValue = '';
      confirmValue = '';
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (auth.needsSetup) {
        handleSetup();
      } else {
        handleUnlock();
      }
    }
  }

  let displayError = $derived(auth.pinError || localError);
</script>

<div class="pin-gate">
  <div class="pin-container">
    <h1>Relay</h1>

    {#if auth.needsSetup}
      <p>set up a PIN to secure this instance</p>
      <PinInput
        bind:value={pinValue}
        onkeydown={handleKeydown}
        placeholder="choose a PIN"
        autofocus
      />
      <PinInput
        bind:value={confirmValue}
        onkeydown={handleKeydown}
        placeholder="confirm PIN"
      />
      <TuiButton variant="primary" onclick={handleSetup}>set PIN</TuiButton>
    {:else}
      <p>enter PIN to continue</p>
      <PinInput
        bind:value={pinValue}
        onkeydown={handleKeydown}
        autofocus
      />
      <TuiButton variant="primary" onclick={handleUnlock}>unlock</TuiButton>
      <p class="hint">forgot your PIN? run <code>claude-remote-cli pin reset</code> on the host machine</p>
    {/if}

    {#if displayError}
      <p class="error">{displayError}</p>
    {/if}
  </div>
</div>

<style>
  .pin-gate {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    background: var(--bg);
    padding: 1rem;
  }

  .pin-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    width: 100%;
    max-width: 320px;
    text-align: center;
  }

  .pin-container h1 {
    font-size: var(--font-size-lg);
    color: var(--text);
  }

  .pin-container p {
    color: var(--text-muted);
    font-size: var(--font-size-base);
  }

  .error {
    color: var(--accent);
    font-size: var(--font-size-base);
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.75rem;
    opacity: 0.6;
    margin-top: -0.25rem;
  }

  code {
    font-family: var(--font-mono, monospace);
    background: var(--surface);
    padding: 2px 5px;
    border-radius: 3px;
    font-size: 0.72rem;
  }
</style>
