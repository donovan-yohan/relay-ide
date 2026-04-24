import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Terminal layout', () => {
  it('locks xterm internals to the Relay viewport instead of native scrolling', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'frontend/src/components/Terminal.css'),
      'utf8'
    );

    expect(css).toContain('.terminal-container .xterm-viewport');
    expect(css).toContain('overflow-y: hidden');
    expect(css).toContain('.terminal-container .xterm-screen');
    expect(css).toContain('overflow: hidden');
  });
});
