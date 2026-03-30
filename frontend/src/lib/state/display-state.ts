export type DisplayState = 'initializing' | 'running' | 'unseen-idle' | 'seen-idle'
  | 'permission' | 'needs-answer' | 'inactive' | 'error';
export type BackendDisplayState = 'initializing' | 'running' | 'idle' | 'permission' | 'error';

export type DisplayEvent =
  | { type: 'backend-state-changed'; state: BackendDisplayState; permissionType?: 'approval' | 'question' }
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
          if (event.permissionType === 'question') return 'needs-answer';
          return 'permission';
        case 'error':
          return 'error';
        case 'initializing':
          return 'initializing';
      }
    }
    // eslint-disable-next-line no-fallthrough
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
  return state === 'unseen-idle' || state === 'permission' || state === 'needs-answer' || state === 'error';
}

export function shouldNotify(from: DisplayState, to: DisplayState): boolean {
  return from === 'running' && isAttentionState(to);
}
