import assert from "node:assert/strict";
import test from "node:test";

import { devToolsEndpointFromOutput } from "../../scripts/cdp-endpoint.mjs";

test("waits for the complete DevTools endpoint line before returning it", () => {
  const endpoint = "ws://127.0.0.1:9222/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
  const chunks = [
    "[123:456:INFO] startup\nDevTools listening on ws://127.0.0.1:9222/devtools/browser/01234567-89ab-",
    "cdef-0123-456789abcdef",
    "\n",
  ];
  let output = "";

  for (const chunk of chunks.slice(0, -1)) {
    output += chunk;
    assert.equal(devToolsEndpointFromOutput(output), undefined);
  }

  output += chunks.at(-1);
  assert.equal(devToolsEndpointFromOutput(output), endpoint);
});
