export type DisplayState = 'initializing' | 'running' | 'unseen-idle' | 'seen-idle' | 'permission' | 'inactive';
export type BackendDisplayState = 'initializing' | 'running' | 'idle' | 'permission';

export type DisplayEvent =
  | { type: 'backend-state-changed'; state: BackendDisplayState }
  | { type: 'user-viewed' }
  | { type: 'session-ended' };

export function transitionDisplayState(current: DisplayState, event: DisplayEvent): DisplayState {
  switch (event.type) {
    case 'backend-state-changed': {
      switch (event.state) {
        case 'idle':
          if (current === 'running' || current === 'initializing') return 'unseen-idle';
          return current;
        case 'running':
          return 'running';
        case 'permission':
          return 'permission';
        case 'initializing':
          return 'initializing';
      }
    }
    case 'user-viewed': {
      if (current === 'unseen-idle' || current === 'permission') return 'seen-idle';
      return current;
    }
    case 'session-ended': {
      return 'inactive';
    }
  }
}

export function isAttentionState(state: DisplayState): boolean {
  return state === 'unseen-idle' || state === 'permission';
}

export function shouldNotify(from: DisplayState, to: DisplayState): boolean {
  return from === 'running' && isAttentionState(to);
}
