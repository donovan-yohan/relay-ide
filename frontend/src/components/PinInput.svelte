<script lang="ts">
  let {
    value = $bindable(''),
    placeholder = 'PIN',
    onkeydown,
    maxlength = 20,
    autofocus = false,
  }: {
    value?: string;
    placeholder?: string;
    onkeydown?: (e: KeyboardEvent) => void;
    maxlength?: number;
    autofocus?: boolean;
  } = $props();

  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let isFocused = $state(false);
  let isIdle = $state(true);
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  let prefersReducedMotion = $state(false);

  let dots = $derived(value.length);
  let showPlaceholder = $derived(!value && !isFocused);

  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion = mq.matches;
    const handler = (e: MediaQueryListEvent) => { prefersReducedMotion = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  });

  function resetIdle() {
    isIdle = false;
    if (idleTimeout !== undefined) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => { isIdle = true; }, 530);
  }

  function handleInput(e: Event) {
    value = (e.target as HTMLInputElement).value;
    resetIdle();
  }

  function handleKeydown(e: KeyboardEvent) {
    resetIdle();
    onkeydown?.(e);
  }

  function handleFocus() {
    isFocused = true;
  }

  function handleBlur() {
    isFocused = false;
    if (idleTimeout !== undefined) {
      clearTimeout(idleTimeout);
      idleTimeout = undefined;
    }
    isIdle = true;
  }

  function focusInput() {
    inputEl?.focus();
  }

  $effect(() => {
    return () => {
      if (idleTimeout !== undefined) clearTimeout(idleTimeout);
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="pin-input"
  class:focused={isFocused}
  onclick={focusInput}
>
  <input
    bind:this={inputEl}
    bind:value
    type="password"
    inputmode="numeric"
    {maxlength}
    class="pin-hidden-input"
    oninput={handleInput}
    onkeydown={handleKeydown}
    onfocus={handleFocus}
    onblur={handleBlur}
    autofocus={autofocus ? true : undefined}
  />
  <div class="pin-display">
    {#if showPlaceholder}
      <span class="pin-placeholder">{placeholder}</span>
    {:else}
      {#each { length: dots } as _, i}
        <span class="pin-dot">{'\u2022'}</span>
      {/each}
      {#if isFocused}
        <span
          class="pin-cursor"
          class:blinking={isIdle && !prefersReducedMotion}
        >&#x2588;</span>
      {/if}
    {/if}
  </div>
</div>

<style>
  .pin-input {
    position: relative;
    width: 100%;
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 16px;
    cursor: text;
    box-sizing: border-box;
  }

  .pin-input.focused {
    border-color: var(--accent);
  }

  .pin-hidden-input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  .pin-display {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: var(--font-size-lg);
    color: var(--text);
    min-height: 1.2em;
    gap: 0.15em;
  }

  .pin-placeholder {
    color: var(--text-muted);
  }

  .pin-dot {
    line-height: 1;
  }

  .pin-cursor {
    opacity: 0.7;
    line-height: 1;
  }

  .pin-cursor.blinking {
    animation: cursor-blink 1s step-end infinite;
  }

  @keyframes cursor-blink {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 0; }
  }
</style>
