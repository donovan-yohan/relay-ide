import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_PENDING_BYTES,
  createTerminalInputQueue,
  takeTerminalInputBatch,
} from "../src/terminal-input.js";

async function eventually(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("queued work did not settle");
}

function deferred() {
  let resolve;
  const promise = new Promise((resolve_) => {
    resolve = resolve_;
  });
  return { promise, resolve };
}

test("terminal input batches on UTF-8 boundaries", () => {
  const [first, remaining] = takeTerminalInputBatch("ab😀cd", 6);
  assert.equal(first, "ab😀");
  assert.equal(remaining, "cd");
  assert.equal(new TextEncoder().encode(first).byteLength, 6);
  assert.throws(() => takeTerminalInputBatch("input", 0), RangeError);
  assert.throws(() => takeTerminalInputBatch("😀", 3), RangeError);
  assert.equal(MAX_TERMINAL_INPUT_BYTES, 8 * 1024);
  assert.equal(MAX_TERMINAL_PENDING_BYTES, 32 * 1024);
});

test("terminal input sends one in-flight request and preserves queue ordering", async () => {
  const first = deferred();
  const sent = [];
  let calls = 0;
  const queue = createTerminalInputQueue({
    isActive: () => true,
    send: async (data) => {
      sent.push(data);
      calls += 1;
      if (calls === 1) await first.promise;
    },
    onError: assert.fail,
  });

  queue.enqueue("first");
  await eventually(() => sent.length === 1);
  queue.enqueue("-second");
  queue.enqueue("-third");
  assert.deepEqual(sent, ["first"]);

  first.resolve();
  await eventually(() => sent.length === 2);
  assert.deepEqual(sent, ["first", "-second-third"]);
});

test("terminal input clears pending work when the terminal closes", async () => {
  const first = deferred();
  const sent = [];
  const queue = createTerminalInputQueue({
    isActive: () => true,
    send: async (data) => {
      sent.push(data);
      await first.promise;
    },
    onError: assert.fail,
  });

  queue.enqueue("first");
  await eventually(() => sent.length === 1);
  queue.enqueue("second");
  queue.dispose();
  first.resolve();
  await Promise.resolve();
  assert.deepEqual(sent, ["first"]);
});

test("terminal input stops when a newer runtime replaces the terminal", async () => {
  const first = deferred();
  const sent = [];
  let active = true;
  const queue = createTerminalInputQueue({
    isActive: () => active,
    send: async (data) => {
      sent.push(data);
      await first.promise;
    },
    onError: assert.fail,
  });

  queue.enqueue("first");
  await eventually(() => sent.length === 1);
  queue.enqueue("second");
  active = false;
  first.resolve();
  await Promise.resolve();
  assert.deepEqual(sent, ["first"]);
});

test("terminal input preserves a transport-rejected batch until explicit retry", async () => {
  const sent = [];
  const errors = [];
  let failFirst = true;
  const queue = createTerminalInputQueue({
    isActive: () => true,
    send: async (data) => {
      sent.push(data);
      if (failFirst) {
        failFirst = false;
        throw { code: "pty_transport" };
      }
    },
    onError: (error) => errors.push(error),
  });

  queue.enqueue("first");
  await eventually(() => errors.length === 1);
  queue.enqueue("second");
  await Promise.resolve();
  assert.equal(queue.isPaused(), true);
  assert.deepEqual(sent, ["first"]);
  assert.equal(queue.resume(), true);
  await eventually(() => sent.length === 2);
  assert.deepEqual(sent, ["first", "firstsecond"]);
  assert.deepEqual(errors, [{ code: "pty_transport" }]);
});

test("terminal input exposes delivery loss and saves the batch for explicit retry", async () => {
  const sent = [];
  const errors = [];
  let failFirst = true;
  const queue = createTerminalInputQueue({
    isActive: () => true,
    send: async (data) => {
      sent.push(data);
      if (failFirst) {
        failFirst = false;
        throw { code: "input_delivery_lost" };
      }
    },
    onError: (error) => errors.push(error),
  });

  queue.enqueue("first");
  await eventually(() => errors.length === 1);
  assert.deepEqual(sent, ["first"]);
  assert.deepEqual(errors, [{ code: "input_delivery_lost" }]);
  assert.equal(queue.isPaused(), true);
  assert.equal(queue.resume(), true);
  await eventually(() => sent.length === 2);
  assert.deepEqual(sent, ["first", "first"]);
});

test("terminal input preserves a network-uncertain batch without automatic replay", async () => {
  const sent = [];
  const errors = [];
  let failFirst = true;
  const queue = createTerminalInputQueue({
    isActive: () => true,
    send: async (data) => {
      sent.push(data);
      if (failFirst) {
        failFirst = false;
        throw new TypeError("Failed to fetch");
      }
    },
    onError: (error) => errors.push(error),
  });

  queue.enqueue("first");
  await eventually(() => errors.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.isPaused(), true);
  assert.deepEqual(sent, ["first"]);
  assert.ok(errors[0] instanceof TypeError);
  assert.equal(queue.resume(), true);
  await eventually(() => sent.length === 2);
  assert.deepEqual(sent, ["first", "first"]);
});

test("terminal input bounds queued bytes without reordering accepted input", async () => {
  const first = deferred();
  const sent = [];
  const errors = [];
  const queue = createTerminalInputQueue({
    isActive: () => true,
    maxPendingBytes: 4,
    send: async (data) => {
      sent.push(data);
      if (data === "one") await first.promise;
    },
    onError: (error) => errors.push(error),
  });

  queue.enqueue("one");
  await eventually(() => sent.length === 1);
  queue.enqueue("abc");
  assert.deepEqual(errors, [{ code: "input_backpressure", delivery: "not_queued" }]);

  first.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue("de");
  await eventually(() => sent.length === 2);
  assert.deepEqual(sent, ["one", "de"]);
});

test("terminal input retains an unaccepted server-backpressure batch", async () => {
  const sent = [];
  const errors = [];
  let attempts = 0;
  const queue = createTerminalInputQueue({
    isActive: () => true,
    send: async (data) => {
      sent.push(data);
      attempts += 1;
      if (attempts === 1) throw { code: "input_backpressure" };
    },
    onError: (error) => errors.push(error),
  });

  queue.enqueue("first");
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(sent, ["first", "first"]);
  assert.deepEqual(errors, []);
});
