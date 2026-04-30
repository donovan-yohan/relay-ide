export type TerminalRenderer = 'webgpu' | 'webgl' | 'dom';

export interface RendererPickContext {
  hasGpu: boolean;
  isMobile: boolean;
  hasWebgl2: boolean;
  isGpuBlocklisted: boolean;
}

/**
 * Pick the best terminal renderer for the current environment.
 *
 * Order: WebGPU (modern Chrome/Edge/Safari 18+, desktop only) →
 *        WebGL  (universal: iOS Safari, Android Chrome, Firefox, older Chromium) →
 *        DOM    (final fallback for blocklisted GPUs / no-GPU environments)
 */
export function pickTerminalRenderer(
  ctx: RendererPickContext
): TerminalRenderer {
  if (ctx.hasGpu && !ctx.isMobile) return 'webgpu';
  if (ctx.hasWebgl2 && !ctx.isGpuBlocklisted) return 'webgl';
  return 'dom';
}

const BLOCKLISTED_RENDERER_SUBSTRINGS = [
  'swiftshader',
  'llvmpipe',
  'microsoft basic',
];

/** Detect software-rendered or Microsoft Basic GPU drivers via WEBGL_debug_renderer_info. */
export function isGpuBlocklisted(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return false;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    if (!debug) return false;
    const renderer = gl.getParameter(
      (debug as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL
    );
    if (typeof renderer !== 'string') return false;
    const r = renderer.toLowerCase();
    return BLOCKLISTED_RENDERER_SUBSTRINGS.some((s) => r.includes(s));
  } catch {
    return false;
  }
}

export function detectRendererContext(
  nav: Pick<Navigator, never> & { gpu?: unknown },
  isMobile: boolean
): RendererPickContext {
  return {
    hasGpu: 'gpu' in nav,
    isMobile,
    hasWebgl2: typeof WebGL2RenderingContext !== 'undefined',
    isGpuBlocklisted: isGpuBlocklisted(),
  };
}
