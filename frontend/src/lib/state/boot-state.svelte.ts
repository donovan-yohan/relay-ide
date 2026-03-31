import { getGreeting } from '../greetings.js';

// Phase flow: idle -> greeting (boot screen mounts, auth runs in background)
//          -> booting (auth succeeded, fetches start)
//          -> ready | degraded (all fetches settled)
// If auth fails or needsSetup: boot screen unmounts, PinGate renders instead.
export type BootPhase = 'idle' | 'greeting' | 'booting' | 'ready' | 'degraded';
export type FetchStatus = 'pending' | 'loading' | 'ok' | 'fail';

export interface BootLine {
  service: string;
  status: FetchStatus;
  summary?: string | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
}

const SERVICES = ['auth', 'workspaces', 'sessions', 'worktrees', 'groups'] as const;

let phase = $state<BootPhase>('idle');
let greeting = $state('');
let lines = $state<BootLine[]>([]);

export function getBootState() {
  return {
    get phase() { return phase; },
    get greeting() { return greeting; },
    get lines() { return lines; },
    get bootComplete() { return phase === 'ready' || phase === 'degraded'; },
  };
}

export function startBoot(): void {
  if (phase !== 'idle') return;
  greeting = getGreeting();
  lines = SERVICES.map(service => ({ service, status: 'pending' as FetchStatus }));
  phase = 'greeting';
}

export function reportFetch(
  service: string,
  status: 'loading' | 'ok' | 'fail',
  opts?: { summary?: string; durationMs?: number; error?: string },
): void {
  const idx = lines.findIndex(l => l.service === service);
  if (idx === -1) return;

  lines[idx] = {
    service,
    status,
    summary: opts?.summary,
    durationMs: opts?.durationMs,
    error: opts?.error,
  };

  // Transition to booting when first non-auth fetch starts loading
  if (phase === 'greeting' && service !== 'auth' && status === 'loading') {
    phase = 'booting';
  }
}

// Called inside refreshAll() after Promise.allSettled() resolves.
// Checks all non-auth lines and transitions phase to ready or degraded.
export function finishBoot(): void {
  const fetchLines = lines.filter(l => l.service !== 'auth');
  const anyFailed = fetchLines.some(l => l.status === 'fail');
  phase = anyFailed ? 'degraded' : 'ready';
}

export function resetBoot(): void {
  lines = SERVICES.map(service => ({ service, status: 'pending' as FetchStatus }));
  phase = 'greeting';
}
