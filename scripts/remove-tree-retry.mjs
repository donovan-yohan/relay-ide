import { rm } from "node:fs/promises";

const TRANSIENT_REMOVE_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

export async function removeTreeWithRetry(
  path,
  {
    maxAttempts = 6,
    remove = (target) => rm(target, { recursive: true, force: true }),
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await remove(path);
      return;
    } catch (error) {
      if (!TRANSIENT_REMOVE_CODES.has(error?.code) || attempt === maxAttempts) throw error;
      await wait(Math.min(25 * (2 ** (attempt - 1)), 200));
    }
  }
}
