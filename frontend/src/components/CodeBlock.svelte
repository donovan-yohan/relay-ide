<script lang="ts">
  import { tokenizeCode, type ThemedToken } from '../lib/shiki.js';

  let {
    code,
    language = 'text',
    showLineNumbers = true,
    startLine = 1,
  }: {
    code: string;
    language?: string;
    showLineNumbers?: boolean;
    startLine?: number;
  } = $props();

  let tokens = $state<ThemedToken[][] | null>(null);
  let error = $state(false);

  $effect(() => {
    const lang = language;
    const src = code;
    error = false;
    tokens = null;
    tokenizeCode(src, lang).then(
      (t) => { tokens = t; },
      () => { error = true; },
    );
  });
</script>

<div class="code-block">
  {#if tokens}
    <pre><code>{#each tokens as line, i (i)}<span class="line">{#if showLineNumbers}<span class="line-number">{startLine + i}</span>{/if}{#each line as token, j (j)}<span style="color: {token.color ?? '#e0e0e0'}">{token.content}</span>{/each}</span>
{/each}</code></pre>
  {:else if error}
    <pre class="fallback"><code>{code}</code></pre>
  {:else}
    <pre class="loading"><code>{code}</code></pre>
  {/if}
</div>

<style>
  .code-block {
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size-xs, 0.75rem);
    line-height: 1.5;
    overflow-x: auto;
    background: transparent;
  }

  pre {
    margin: 0;
    white-space: pre;
  }

  code {
    display: block;
  }

  .line {
    display: block;
    min-height: 1.5em;
  }

  .line-number {
    display: inline-block;
    width: 3.5em;
    text-align: right;
    padding-right: 1em;
    color: #888888;
    user-select: none;
  }

  .fallback, .loading {
    color: var(--text, #e0e0e0);
  }

  .loading {
    opacity: 0.5;
  }
</style>
