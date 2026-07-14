import assert from "node:assert/strict";
import test from "node:test";

import { removeTreeWithRetry } from "../../scripts/remove-tree-retry.mjs";

test("temporary tree cleanup retries only bounded transient filesystem failures", async () => {
  const delays = [];
  let attempts = 0;
  await removeTreeWithRetry("/tmp/browser-profile", {
    maxAttempts: 4,
    remove: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("profile busy"), { code: "ENOTEMPTY" });
    },
    wait: async (delayMs) => { delays.push(delayMs); },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);

  attempts = 0;
  await assert.rejects(
    removeTreeWithRetry("/tmp/browser-profile", {
      remove: async () => {
        attempts += 1;
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      },
      wait: async () => {},
    }),
    { code: "EACCES" },
  );
  assert.equal(attempts, 1);
});

test("temporary tree cleanup surfaces the last error after its retry budget", async () => {
  let attempts = 0;
  await assert.rejects(
    removeTreeWithRetry("/tmp/browser-profile", {
      maxAttempts: 3,
      remove: async () => {
        attempts += 1;
        throw Object.assign(new Error(`busy ${attempts}`), { code: "EBUSY" });
      },
      wait: async () => {},
    }),
    (error) => error.code === "EBUSY" && error.message === "busy 3",
  );
  assert.equal(attempts, 3);
});
