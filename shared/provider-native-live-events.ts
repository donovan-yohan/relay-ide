import type { NativeSessionProvider } from './provider-native-session-state.js';

/**
 * Normalized live event emitted by native-session tails (#1428).
 *
 * The shape is provider-neutral: `type`/`text` carry the shared vocabulary,
 * while `providerEvent` preserves the raw event's type string so consumers can
 * still see what the harness actually said. Payloads are redacted and bounded
 * before publication; raw transcript bytes never ride the bus.
 */
export interface NativeSessionLiveEvent {
  provider: NativeSessionProvider;
  /** Native session id the event belongs to. */
  nativeId: string;
  sourcePath: string;
  /** Deterministic normalized kind from the shared patch/event vocabulary. */
  kind:
    | 'user-message'
    | 'assistant-message'
    | 'reasoning'
    | 'tool-call'
    | 'tool-result'
    | 'session-started'
    | 'gap';
  /** Redacted, size-bounded text preview (empty for non-text kinds). */
  text: string;
  /** The provider's own event type string, preserved for attribution. */
  providerEvent: string;
  timestamp?: string;
}

/** Text previews on the live bus are bounded harder than imports. */
export const NATIVE_LIVE_TEXT_LIMIT = 2_000;
