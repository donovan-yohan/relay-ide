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
}) {
  let pending = "";
  let pendingBytes = 0;
  let sending = false;
  let disposed = false;
  let retryTimer = null;

  async function flush() {
    if (disposed || sending || !isActive() || !pending) return;
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
        pendingBytes -= encoder.encode(data).byteLength;
        onError(error);
      }
    } finally {
      sending = false;
      if (!disposed && isActive() && pending && retryTimer === null) void flush();
    }
  }

  return {
    enqueue(data) {
      if (disposed || !isActive() || !data) return;
      const dataBytes = encoder.encode(data).byteLength;
      if (pendingBytes + dataBytes > maxPendingBytes) {
        onError({ code: "input_backpressure" });
        return;
      }
      pending += data;
      pendingBytes += dataBytes;
      void flush();
    },
    dispose() {
      disposed = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      pending = "";
      pendingBytes = 0;
    },
  };
}
