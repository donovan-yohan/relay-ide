// Shared chat-input submit primitives (#1308 slice 1 item 3).
//
// Extracted verbatim from `ChannelComposer` so the in-place message editor
// submits by exactly the same rules the composer does — including the mobile
// path, which is the part that is easy to get wrong: some IMEs report only a
// `beforeinput` line-break intent for the send key and no reliable `keydown`,
// so a hand-rolled `onKeyDown` editor would simply not send on those keyboards.

export const LINE_BREAK_INPUT_TYPES = new Set([
  'insertLineBreak',
  'insertParagraph',
]);

/**
 * Window after a shift+enter keydown during which the matching `beforeinput`
 * line break is treated as a newline rather than a send.
 */
export const LINE_BREAK_BEFOREINPUT_SKIP_WINDOW_MS = 500;

export interface LineBreakSubmitGuard {
  /** A shift+enter keydown just fired — let its `beforeinput` insert a newline. */
  deferNextLineBreak(): void;
  /** Any other keydown: the next line-break intent is a send again. */
  reset(): void;
  /**
   * True when this `beforeinput` is the on-screen send key and the caller
   * should submit. Consumes the deferral window, so a deferred line break falls
   * through as an ordinary newline exactly once.
   */
  consumesAsSubmit(event: InputEvent): boolean;
}

export function createLineBreakSubmitGuard(
  now: () => number = () => performance.now()
): LineBreakSubmitGuard {
  let skipUntil = 0;
  return {
    deferNextLineBreak() {
      skipUntil = now() + LINE_BREAK_BEFOREINPUT_SKIP_WINDOW_MS;
    },
    reset() {
      skipUntil = 0;
    },
    consumesAsSubmit(event) {
      if (!LINE_BREAK_INPUT_TYPES.has(event.inputType)) return false;
      if (event.isComposing) return false;
      if (skipUntil > 0 && now() <= skipUntil) {
        skipUntil = 0;
        return false;
      }
      skipUntil = 0;
      return true;
    },
  };
}
