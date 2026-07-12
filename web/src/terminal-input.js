export const MAX_TERMINAL_INPUT_BYTES = 8 * 1024;
export const MAX_TERMINAL_PENDING_BYTES = 4 * MAX_TERMINAL_INPUT_BYTES;

const encoder = new TextEncoder();

export function takeTerminalInputBatch(data, maxBytes = MAX_TERMINAL_INPUT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive integer");
  }
  if (!data) return ["", ""];

  let end = 0;
  let bytes = 0;
  for (const character of data) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) {
      if (bytes === 0) throw new RangeError("maxBytes must fit one UTF-8 code point");
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  return [data.slice(0, end), data.slice(end)];
}

export function createTerminalInputQueue({
  isActive,
  send,
  onError,
  maxBytes = MAX_TERMINAL_INPUT_BYTES,
  maxPendingBytes = MAX_TERMINAL_PENDING_BYTES,
  initialPausedInput = "",
}) {
  const restoredInput = typeof initialPausedInput === "string" ? initialPausedInput : "";
  let pending = restoredInput;
  let pendingBytes = encoder.encode(restoredInput).byteLength;
  let sending = false;
  let disposed = false;
  let paused = Boolean(restoredInput);
  let retryTimer = null;

  async function flush() {
    if (disposed || paused || sending || !isActive() || !pending) return;
    const [data, remaining] = takeTerminalInputBatch(pending, maxBytes);
    pending = remaining;
    sending = true;
    try {
      await send(data);
      pendingBytes -= encoder.encode(data).byteLength;
    } catch (error) {
      if (!disposed && isActive() && error?.code === "input_backpressure") {
        pending = data + pending;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void flush();
        }, 50);
      } else if (!disposed && isActive()) {
        // A rejected request is safe to retry, while a failed network request
        // may already have reached Relay. Preserve both cases for an explicit
        // operator decision instead of silently dropping typed terminal input.
        pending = data + pending;
        paused = true;
        onError(error);
      }
    } finally {
      sending = false;
      if (!disposed && !paused && isActive() && pending && retryTimer === null) void flush();
    }
  }

  return {
    enqueue(data) {
      if (disposed || !isActive() || !data) return;
      const dataBytes = encoder.encode(data).byteLength;
      if (pendingBytes + dataBytes > maxPendingBytes) {
        onError({ code: "input_backpressure", delivery: "not_queued" });
        return;
      }
      pending += data;
      pendingBytes += dataBytes;
      void flush();
    },
    resume() {
      if (disposed || !paused || !isActive()) return false;
      paused = false;
      void flush();
      return true;
    },
    discard() {
      if (disposed || !paused) return false;
      paused = false;
      pending = "";
      pendingBytes = 0;
      return true;
    },
    isPaused() {
      return paused;
    },
    pausedInput() {
      return paused && pending ? pending : null;
    },
    dispose() {
      disposed = true;
      paused = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      pending = "";
      pendingBytes = 0;
    },
  };
}
