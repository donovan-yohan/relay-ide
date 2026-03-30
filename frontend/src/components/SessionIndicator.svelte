<script lang="ts">
  import type { DisplayState } from '../lib/state/display-state.js';

  let { state }: { state: DisplayState } = $props();

  const config: Record<DisplayState, { char: string; colorClass: string; bold: boolean }> = {
    initializing:    { char: '●', colorClass: 'ind-green-dim',    bold: false },
    running:         { char: '●', colorClass: 'ind-green',        bold: false },
    'unseen-idle':   { char: '▶', colorClass: 'ind-yellow',       bold: false },
    'seen-idle':     { char: '▶', colorClass: 'ind-yellow-muted', bold: false },
    permission:      { char: '◆', colorClass: 'ind-red',          bold: true  },
    'needs-answer':  { char: '◇', colorClass: 'ind-red',          bold: true  },
    error:           { char: '■', colorClass: 'ind-red',          bold: false },
    inactive:        { char: '─', colorClass: 'ind-gray',         bold: false },
  };

  let cfg = $derived(config[state]);
  let char = $derived(cfg.char);
  let colorClass = $derived(cfg.colorClass);
  let bold = $derived(cfg.bold);

  let pulseClass = $derived(
    state === 'permission' || state === 'needs-answer' ? 'pulse-fast'
    : state === 'unseen-idle' ? 'pulse-slow'
    : ''
  );

  let label = $derived(
    state === 'permission' ? 'needs approval'
    : state === 'needs-answer' ? 'needs answer'
    : state === 'unseen-idle' ? 'idle, unread'
    : state === 'seen-idle' ? 'idle'
    : state
  );
</script>

<span
  class="session-indicator {colorClass} {pulseClass}"
  class:bold
  role="img"
  aria-label={label}
>{char}</span>

<style>
  .session-indicator {
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    text-align: center;
  }

  .bold { font-weight: 700; }

  .ind-green       { color: rgba(74, 222, 128, 0.8); }
  .ind-green-dim   { color: rgba(74, 222, 128, 0.4); }
  .ind-yellow      { color: #f0c674; }
  .ind-yellow-muted { color: rgba(240, 198, 116, 0.5); }
  .ind-red         { color: #cc6666; }
  .ind-gray        { color: #555; }

  @keyframes pulse-red {
    0%, 100% { color: rgba(204, 102, 102, 1); }
    50%      { color: rgba(204, 102, 102, 0.15); }
  }

  @keyframes pulse-yellow {
    0%, 100% { color: rgba(240, 198, 116, 1); }
    50%      { color: rgba(240, 198, 116, 0.15); }
  }

  .pulse-fast { animation: pulse-red 1.4s ease-in-out infinite; }
  .pulse-slow { animation: pulse-yellow 2.5s ease-in-out infinite; }

  @media (prefers-reduced-motion: reduce) {
    .pulse-fast, .pulse-slow { animation: none; }
  }
</style>
