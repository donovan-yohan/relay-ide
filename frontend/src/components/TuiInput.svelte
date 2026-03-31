<script lang="ts">
  let {
    value = $bindable(''),
    placeholder,
    type = 'text',
    disabled = false,
    id,
    oninput,
    onkeydown,
    ...rest
  }: {
    value?: string;
    placeholder?: string;
    type?: 'text' | 'password';
    disabled?: boolean;
    id?: string;
    oninput?: (e: Event) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    [key: string]: unknown;
  } = $props();

  let inputEl = $state<HTMLInputElement | undefined>(undefined);
  let measureEl = $state<HTMLSpanElement | undefined>(undefined);
  let isFocused = $state(false);
  let isIdle = $state(true);
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  let prefersReducedMotion = $state(false);
  let cursorLeft = $state(0);
  let cursorHeight = $state(16);

  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion = mq.matches;
    const handler = (e: MediaQueryListEvent) => { prefersReducedMotion = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  });

  function updateCursorPosition() {
    if (!inputEl || !measureEl) return;

    const selStart = inputEl.selectionStart ?? 0;
    const textBeforeCursor = type === 'password'
      ? '\u2022'.repeat(selStart)
      : (value ?? '').slice(0, selStart);

    measureEl.textContent = textBeforeCursor || '';
    cursorLeft = measureEl.offsetWidth;
    cursorHeight = inputEl.offsetHeight || 16;
  }

  $effect(() => {
    // Re-measure when value changes
    const _ = value;
    updateCursorPosition();
  });

  function handleInput(e: Event) {
    value = (e.target as HTMLInputElement).value;
    isIdle = false;
    if (idleTimeout !== undefined) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => { isIdle = true; }, 530);
    updateCursorPosition();
    oninput?.(e);
  }

  function handleKeydown(e: KeyboardEvent) {
    isIdle = false;
    if (idleTimeout !== undefined) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => { isIdle = true; }, 530);
    // Update cursor after keydown (e.g. arrow keys)
    requestAnimationFrame(updateCursorPosition);
    onkeydown?.(e);
  }

  function handleFocus() {
    isFocused = true;
    updateCursorPosition();
  }

  function handleBlur() {
    isFocused = false;
    if (idleTimeout !== undefined) {
      clearTimeout(idleTimeout);
      idleTimeout = undefined;
    }
    isIdle = true;
  }

  function handleClick() {
    requestAnimationFrame(updateCursorPosition);
  }

  $effect(() => {
    return () => {
      if (idleTimeout !== undefined) clearTimeout(idleTimeout);
    };
  });
</script>

<div class="tui-input-wrapper">
  <input
    bind:this={inputEl}
    bind:value
    {type}
    {disabled}
    {id}
    {placeholder}
    class="tui-input"
    oninput={handleInput}
    onkeydown={handleKeydown}
    onfocus={handleFocus}
    onblur={handleBlur}
    onclick={handleClick}
    {...rest}
  />
  <!-- Hidden span for text width measurement -->
  <span class="tui-measure" bind:this={measureEl} aria-hidden="true"></span>
  <!-- Block cursor overlay -->
  {#if isFocused && !disabled}
    <span
      class="tui-cursor"
      class:blinking={isIdle && !prefersReducedMotion}
      style:left="{cursorLeft}px"
      style:height="{cursorHeight}px"
      aria-hidden="true"
    >&#x2588;</span>
  {/if}
</div>

<style>
  .tui-input-wrapper {
    position: relative;
    display: inline-flex;
    align-items: center;
    overflow: hidden;
    width: 100%;
  }

  .tui-input {
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
    padding: 8px 8px;
    width: 100%;
    box-sizing: border-box;
    caret-color: transparent;
    outline: none;
    border-radius: 0;
  }

  .tui-input:focus {
    border-color: var(--accent);
  }

  .tui-input:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .tui-input::placeholder {
    color: var(--text-muted);
  }

  /* Hidden measurement span — must match input font exactly */
  .tui-measure {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
    white-space: pre;
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    /* Match input padding offset */
    left: 8px;
    top: 0;
    padding: 0;
    border: none;
    line-height: 1;
  }

  .tui-cursor {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    color: var(--text);
    opacity: 0.7;
    pointer-events: none;
    line-height: 1;
    /* Offset by input padding */
    margin-left: 8px;
  }

  .tui-cursor.blinking {
    animation: cursor-blink 1s step-end infinite;
  }

  @keyframes cursor-blink {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 0; }
  }
</style>
