import { describe, expect, it } from 'vitest';
import {
  pickTerminalRenderer,
  type RendererPickContext,
} from '../frontend/src/lib/terminal-renderer.js';

const ctx = (
  overrides: Partial<RendererPickContext> = {}
): RendererPickContext => ({
  hasGpu: false,
  isMobile: false,
  hasWebgl2: false,
  isGpuBlocklisted: false,
  ...overrides,
});

describe('pickTerminalRenderer', () => {
  it('returns webgpu on desktop with GPU', () => {
    expect(pickTerminalRenderer(ctx({ hasGpu: true, hasWebgl2: true }))).toBe(
      'webgpu'
    );
  });

  it('skips webgpu on mobile, falls to webgl when webgl2 available', () => {
    expect(
      pickTerminalRenderer(
        ctx({ hasGpu: true, isMobile: true, hasWebgl2: true })
      )
    ).toBe('webgl');
  });

  it('returns webgl when no webgpu but webgl2 available and not blocklisted', () => {
    expect(pickTerminalRenderer(ctx({ hasWebgl2: true }))).toBe('webgl');
  });

  it('returns dom when GPU blocklisted (SwiftShader/LLVMpipe)', () => {
    expect(
      pickTerminalRenderer(ctx({ hasWebgl2: true, isGpuBlocklisted: true }))
    ).toBe('dom');
  });

  it('returns dom when blocklisted on mobile too', () => {
    expect(
      pickTerminalRenderer(
        ctx({ isMobile: true, hasWebgl2: true, isGpuBlocklisted: true })
      )
    ).toBe('dom');
  });

  it('returns dom when no webgl2 and no webgpu', () => {
    expect(pickTerminalRenderer(ctx())).toBe('dom');
  });

  it('returns dom on mobile when webgl2 unavailable (very old)', () => {
    expect(pickTerminalRenderer(ctx({ isMobile: true, hasGpu: true }))).toBe(
      'dom'
    );
  });

  it('prefers webgpu over webgl when both available on desktop', () => {
    expect(
      pickTerminalRenderer(
        ctx({ hasGpu: true, hasWebgl2: true, isGpuBlocklisted: true })
      )
    ).toBe('webgpu');
  });
});
