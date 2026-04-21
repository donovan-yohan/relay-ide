export interface CapturedIntent {
  type: string;
  data: string | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  valueBefore: string;
  cursorBefore: number;
}

export interface PipelineResult {
  /** Bytes to send to PTY (backspaces + replacement text) */
  payload: string;
  /** If set, caller must update inputEl.value and call ensureCursorAtEnd() */
  newInputValue?: string;
  /** Debug info for diagnostics */
  debug?: string;
}

export function codepointCount(str: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    count++;
    if (str.charCodeAt(i) >= 0xd800 && str.charCodeAt(i) <= 0xdbff) i++;
  }
  return count;
}

export function commonPrefixLength(a: string, b: string): number {
  let len = 0;
  while (len < a.length && len < b.length && a[len] === b[len]) len++;
  return len;
}

const DEL = '\x7f';

function makeBackspaces(count: number): string {
  let s = '';
  for (let i = 0; i < count; i++) s += DEL;
  return s;
}

function handleInsert(
  intent: CapturedIntent,
  currentValue: string
): PipelineResult {
  const { rangeStart, rangeEnd, data } = intent;

  if (rangeStart !== null && rangeEnd !== null && rangeStart !== rangeEnd) {
    // Non-collapsed range = autocorrect replacement
    const replaced = intent.valueBefore.slice(rangeStart, rangeEnd);
    const charsToDelete = codepointCount(replaced);
    const payload = makeBackspaces(charsToDelete) + (data ?? '');
    return { payload };
  }

  if (data) {
    // Gboard cursor-0 bug: keyboard loses cursor position and prepends the
    // replacement word at position 0 instead of replacing the last word in place.
    // Detect by: multi-char data, cursor was at 0, and new value = data + old value.
    const isCursor0Prepend =
      data.length > 1 &&
      intent.cursorBefore === 0 &&
      intent.valueBefore.length > 0 &&
      currentValue === data + intent.valueBefore;

    if (isCursor0Prepend) {
      const lastSpaceIdx = intent.valueBefore.lastIndexOf(' ');
      const lastWord =
        lastSpaceIdx >= 0
          ? intent.valueBefore.slice(lastSpaceIdx + 1)
          : intent.valueBefore;

      // Buffer ends with a space — nothing to autocorrect
      if (lastWord.length === 0) {
        return {
          payload: '',
          newInputValue: intent.valueBefore,
          debug: 'CURSOR0: empty lastWord, skip',
        };
      }

      const prefix =
        lastSpaceIdx >= 0 ? intent.valueBefore.slice(0, lastSpaceIdx + 1) : '';
      // Gboard sometimes sends the full replacement word (data[0] === firstChar,
      // e.g. "teh" → data="the") and sometimes only the suffix after the first
      // char (data[0] !== firstChar, e.g. "tsestin" → data="esting ").
      // Evidence from device diagnostics confirms both patterns occur.
      const firstChar = lastWord.charAt(0);
      const isSuffix = data.charAt(0) !== firstChar;
      const replacement = isSuffix ? firstChar + data : data;
      const payload = makeBackspaces(codepointCount(lastWord)) + replacement;
      const debug = `CURSOR0: lastWord="${lastWord}" firstChar="${firstChar}" data[0]="${data.charAt(0)}" mode=${isSuffix ? 'suffix' : 'fullword'} replacement="${replacement}" del=${codepointCount(lastWord)}`;
      return { payload, newInputValue: prefix + replacement, debug };
    }

    return { payload: data };
  }

  // No data and no range — fall back to diff
  return handleFallbackDiff(intent, currentValue);
}

function handleDelete(
  intent: CapturedIntent,
  currentValue: string
): PipelineResult {
  const { rangeStart, rangeEnd, valueBefore } = intent;

  if (rangeStart !== null && rangeEnd !== null) {
    const deleted = valueBefore.slice(rangeStart, rangeEnd);
    const charsToDelete = codepointCount(deleted);
    return { payload: makeBackspaces(charsToDelete) };
  }

  // No range info — diff to figure out how many chars were deleted
  const deleted = valueBefore.length - currentValue.length;
  const charsToDelete = Math.max(1, deleted);
  return { payload: makeBackspaces(charsToDelete) };
}

function handleReplacement(
  intent: CapturedIntent,
  currentValue: string
): PipelineResult {
  const { rangeStart, rangeEnd, data, valueBefore } = intent;

  if (rangeStart !== null && rangeEnd !== null) {
    const replaced = valueBefore.slice(rangeStart, rangeEnd);
    const charsToDelete = codepointCount(replaced);
    const payload = makeBackspaces(charsToDelete) + (data ?? '');
    return { payload };
  }

  return handleFallbackDiff(intent, currentValue);
}

function handlePaste(
  intent: CapturedIntent,
  currentValue: string
): PipelineResult {
  const commonLen = commonPrefixLength(intent.valueBefore, currentValue);
  const pasted = currentValue.slice(commonLen);
  return { payload: pasted };
}

function handleFallbackDiff(
  intent: CapturedIntent,
  currentValue: string
): PipelineResult {
  const valueBefore = intent.valueBefore || '';
  if (currentValue === valueBefore) {
    return { payload: '' };
  }
  const commonLen = commonPrefixLength(valueBefore, currentValue);
  const deletedSlice = valueBefore.slice(commonLen);
  const charsToDelete = codepointCount(deletedSlice);
  const newChars = currentValue.slice(commonLen);
  const payload = makeBackspaces(charsToDelete) + newChars;
  return { payload };
}

export function processIntent(
  intent: CapturedIntent,
  currentValue: string
): PipelineResult {
  switch (intent.type) {
    case 'insertText':
      return handleInsert(intent, currentValue);
    case 'deleteContentBackward':
    case 'deleteContentForward':
    case 'deleteWordBackward':
    case 'deleteWordForward':
    case 'deleteSoftLineBackward':
    case 'deleteSoftLineForward':
    case 'deleteBySoftwareKeyboard':
      return handleDelete(intent, currentValue);
    case 'insertReplacementText':
      return handleReplacement(intent, currentValue);
    case 'insertFromPaste':
    case 'insertFromDrop':
      return handlePaste(intent, currentValue);
    default:
      return handleFallbackDiff(intent, currentValue);
  }
}
