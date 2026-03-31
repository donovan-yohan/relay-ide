<script lang="ts">
  import CipherText from './CipherText.svelte';
  import TuiProgress from './TuiProgress.svelte';
  import { getBootState, resetBoot, reportFetch, finishBoot } from '../lib/state/boot-state.svelte.js';
  import { refreshAll } from '../lib/state/sessions.svelte.js';
  import type { BootLine } from '../lib/state/boot-state.svelte.js';

  const boot = getBootState();

  let fadingOut = $state(false);
  let retrying = $state(false);

  $effect(() => {
    if (boot.bootComplete && !fadingOut) {
      fadingOut = true;
    }
  });

  const allFailed = $derived(
    boot.phase === 'booting' || boot.phase === 'degraded'
      ? boot.lines.filter(l => l.service !== 'auth').every(l => l.status === 'fail')
      : false,
  );

  async function handleRetry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    resetBoot();
    await refreshAll(reportFetch);
    finishBoot();
    retrying = false;
  }

  function badgeText(line: BootLine): string {
    switch (line.status) {
      case 'ok': return '[ok]';
      case 'fail': return '[fail]';
      default: return '';
    }
  }

  function formatDuration(ms: number | undefined): string {
    if (ms === undefined) return '';
    return `${ms}ms`;
  }
</script>

<div
  class="boot-screen"
  class:fading-out={fadingOut}
  role="status"
  aria-live="polite"
>
  <div class="boot-content">
    <div class="greeting" aria-label={boot.greeting}>
      <CipherText text={boot.greeting} loading={boot.phase === 'idle'} />
    </div>

    <div class="status-lines">
      {#each boot.lines as line (line.service)}
        <div
          class="status-line"
          class:pending={line.status === 'pending'}
          aria-label={line.status === 'ok'
            ? `${line.service}: ok${line.summary ? `, ${line.summary}` : ''}${line.durationMs ? `, ${line.durationMs} milliseconds` : ''}`
            : line.status === 'fail'
              ? `${line.service}: failed${line.error ? `, ${line.error}` : ''}`
              : `${line.service}: ${line.status}`}
        >
          <span class="service-name">{line.service}</span>
          <span class="badge" class:badge-ok={line.status === 'ok'} class:badge-fail={line.status === 'fail'}>
            {#if line.status === 'loading'}
              <TuiProgress variant="braille" />
            {:else if line.status === 'pending'}
              <span class="dot">&middot;</span>
            {:else}
              {badgeText(line)}
            {/if}
          </span>
          <span class="summary">
            {#if line.status === 'loading'}
              loading...
            {:else if line.status === 'ok' && line.summary}
              {line.summary}
            {:else if line.status === 'fail' && line.error}
              {line.error}
            {/if}
          </span>
          <span class="duration">
            {formatDuration(line.durationMs)}
          </span>
        </div>
      {/each}
    </div>

    {#if boot.phase === 'ready'}
      <div class="ready-line">ready.</div>
    {:else if boot.phase === 'degraded' && !allFailed}
      <div class="ready-line degraded">ready (degraded).</div>
    {:else if allFailed}
      <div class="retry-line">
        connection failed.
        <button class="retry-btn" onclick={handleRetry} disabled={retrying}>{retrying ? '[retrying...]' : '[retry]'}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .boot-screen {
    position: fixed;
    inset: 0;
    background: var(--bg);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
    opacity: 1;
    transition: opacity 300ms ease-in;
  }

  .boot-screen.fading-out {
    opacity: 0;
    pointer-events: none;
  }

  .boot-content {
    max-width: 480px;
    width: 100%;
    padding: 48px 32px;
  }

  .greeting {
    font-size: 16px;
    color: var(--accent);
    margin-bottom: 24px;
    letter-spacing: 0.5px;
  }

  .status-lines {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .status-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0;
    font-size: 13px;
    font-family: var(--font-mono);
  }

  .status-line.pending {
    opacity: 0.3;
  }

  .service-name {
    width: 110px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .badge {
    width: 44px;
    flex-shrink: 0;
    text-align: center;
    font-family: var(--font-mono);
  }

  .badge-ok {
    color: var(--status-success);
  }

  .badge-fail {
    color: var(--status-error);
  }

  .dot {
    color: var(--text-muted);
  }

  .summary {
    flex: 1;
    color: var(--text-muted);
    font-size: 12px;
  }

  .duration {
    color: var(--text-muted);
    opacity: 0.5;
    font-size: 11px;
    width: 48px;
    text-align: right;
    flex-shrink: 0;
  }

  .ready-line {
    margin-top: 16px;
    color: var(--status-success);
    font-size: 13px;
    font-family: var(--font-mono);
  }

  .ready-line.degraded {
    color: var(--status-warning);
  }

  .retry-line {
    margin-top: 16px;
    color: var(--status-error);
    font-size: 13px;
    font-family: var(--font-mono);
  }

  .retry-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 13px;
    cursor: pointer;
    padding: 2px 8px;
    margin-left: 8px;
  }

  .retry-btn:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }

  @media (prefers-reduced-motion: reduce) {
    .boot-screen {
      transition: none;
    }
  }
</style>
