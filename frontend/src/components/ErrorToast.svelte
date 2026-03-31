<script lang="ts">
  import { getToasts, dismissToast } from '../lib/state/toasts.svelte.js';

  let toasts = $derived(getToasts());
</script>

{#each toasts as toast (toast.id)}
  <div class="error-toast" class:error-toast--error={toast.variant === 'error'} class:error-toast--info={toast.variant === 'info'}>
    <div class="error-toast-content">
      <span class="error-toast-text">{toast.message}</span>
      <button class="error-toast-dismiss" onclick={() => dismissToast(toast.id)} aria-label="Dismiss">
        &times;
      </button>
    </div>
  </div>
{/each}

<style>
  .error-toast {
    position: fixed;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1100;
    max-width: 90vw;
    animation: toast-slide-up 0.25s ease-out;
    pointer-events: auto;
  }

  .error-toast:nth-child(2) {
    bottom: 56px;
  }

  .error-toast:nth-child(3) {
    bottom: 100px;
  }

  @keyframes toast-slide-up {
    from {
      transform: translateX(-50%) translateY(100%);
      opacity: 0;
    }
    to {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
  }

  .error-toast-content {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0;
    padding: 10px 16px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  }

  .error-toast--error .error-toast-content {
    border-color: var(--status-error);
  }

  .error-toast--info .error-toast-content {
    border-color: var(--border);
  }

  .error-toast-text {
    flex: 1;
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .error-toast-dismiss {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: var(--font-size-lg);
    padding: 4px 8px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .error-toast-dismiss:hover {
    color: var(--text);
  }
</style>
