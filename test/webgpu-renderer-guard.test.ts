import { describe, it, expect } from 'vitest';
import { shouldUseWebGpuRenderer } from '../frontend/src/lib/terminal-zoom.js';

describe('shouldUseWebGpuRenderer', () => {
  it('returns true when GPU is available and not mobile', () => {
    expect(shouldUseWebGpuRenderer(true, false)).toBe(true);
  });

  it('returns false when GPU is available but on mobile', () => {
    expect(shouldUseWebGpuRenderer(true, true)).toBe(false);
  });

  it('returns false when GPU is not available on desktop', () => {
    expect(shouldUseWebGpuRenderer(false, false)).toBe(false);
  });

  it('returns false when GPU is not available on mobile', () => {
    expect(shouldUseWebGpuRenderer(false, true)).toBe(false);
  });
});
