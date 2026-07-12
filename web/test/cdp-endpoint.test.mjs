import assert from "node:assert/strict";
import test from "node:test";

import {
  devToolsEndpointFromActivePort,
  devToolsEndpointFromOutput,
} from "../../scripts/cdp-endpoint.mjs";

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

test("uses Chrome's profile-owned DevToolsActivePort endpoint when stdout is unavailable", () => {
  assert.equal(
    devToolsEndpointFromActivePort("46785\n/devtools/browser/01234567-89ab-cdef-0123-456789abcdef\n"),
    "ws://127.0.0.1:46785/devtools/browser/01234567-89ab-cdef-0123-456789abcdef",
  );
  assert.equal(devToolsEndpointFromActivePort("46785\n"), undefined);
  assert.equal(devToolsEndpointFromActivePort("not-a-port\n/devtools/browser/id\n"), undefined);
});
