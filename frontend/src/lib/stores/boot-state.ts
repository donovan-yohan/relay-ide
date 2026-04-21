import { create } from 'zustand';
import { getGreeting } from '../greetings.js';

export type BootPhase = 'idle' | 'greeting' | 'booting' | 'ready' | 'degraded';
export type FetchStatus = 'pending' | 'loading' | 'ok' | 'fail';

export interface BootLine {
  service: string;
  status: FetchStatus;
  summary?: string | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
}

const SERVICES = [
  'auth',
  'workspaces',
  'sessions',
  'worktrees',
  'groups',
] as const;

function makePendingLines(): BootLine[] {
  return SERVICES.map((service) => ({
    service,
    status: 'pending' as FetchStatus,
  }));
}

export interface BootStateStore {
  phase: BootPhase;
  greeting: string;
  lines: BootLine[];
  bootComplete: boolean;
  startBoot: () => void;
  reportFetch: (
    service: string,
    status: 'loading' | 'ok' | 'fail',
    opts?: { summary?: string; durationMs?: number; error?: string }
  ) => void;
  finishBoot: () => void;
  resetBoot: () => void;
}

export const useBootStateStore = create<BootStateStore>()((set, get) => ({
  phase: 'idle',
  greeting: '',
  lines: [],
  bootComplete: false,

  startBoot: () => {
    if (get().phase !== 'idle') return;
    set({
      greeting: getGreeting(),
      lines: makePendingLines(),
      phase: 'greeting',
    });
  },

  reportFetch: (service, status, opts) => {
    const { lines, phase } = get();
    const idx = lines.findIndex((l) => l.service === service);
    if (idx === -1) return;
    const next = [...lines];
    next[idx] = {
      service,
      status,
      summary: opts?.summary,
      durationMs: opts?.durationMs,
      error: opts?.error,
    };
    const newPhase =
      phase === 'greeting' && service !== 'auth' && status === 'loading'
        ? 'booting'
        : phase;
    set({ lines: next, phase: newPhase });
  },

  finishBoot: () => {
    const { lines } = get();
    const fetchLines = lines.filter((l) => l.service !== 'auth');
    const anyFailed = fetchLines.some((l) => l.status === 'fail');
    const phase: BootPhase = anyFailed ? 'degraded' : 'ready';
    set({ phase, bootComplete: true });
  },

  resetBoot: () => {
    set({ lines: makePendingLines(), phase: 'greeting', bootComplete: false });
  },
}));
