import assert from "node:assert/strict";
import test from "node:test";

import { terminalErrorPresentation, terminalInputRecovery } from "../src/terminal-recovery.js";

test("terminal transport and capacity errors stay out of passkey presentation", () => {
  for (const [code, expected] of [
    ["pty_transport", "terminal transport"],
    ["session_capacity", "terminal-session capacity"],
    ["session_missing", "browser session"],
    ["csrf_denied", "terminal control request"],
    ["session_forbidden", "different Relay browser device"],
    ["invalid_resize", "terminal size"],
    ["invalid_input", "terminal input"],
    ["pty_teardown_failed", "terminal shutdown"],
  ]) {
    const presentation = terminalErrorPresentation({ code });
    assert.equal(presentation.code, code);
    assert.match(presentation.message, new RegExp(expected, "i"));
    assert.doesNotMatch(presentation.message, /passkey|ceremony/i);
  }
});

test("network TypeError renders terminal recovery rather than passkey ceremony copy", () => {
  const presentation = terminalErrorPresentation(new TypeError("Failed to fetch"));

  assert.equal(presentation.code, "network_uncertain");
  assert.match(presentation.message, /terminal/i);
  assert.match(presentation.message, /uncertain/i);
  assert.doesNotMatch(presentation.message, /passkey|ceremony/i);
});

test("lost input delivery tells the operator to inspect before retrying saved input", () => {
  const presentation = terminalInputRecovery({ code: "input_delivery_lost" });

  assert.equal(presentation.code, "input_delivery_lost");
  assert.match(presentation.message, /previously queued input batch/i);
  assert.match(presentation.message, /inspect the terminal/i);
  assert.match(presentation.message, /saved input/i);
});

test("local queue admission failure marks input as not queued", () => {
  const presentation = terminalInputRecovery({ code: "input_backpressure", delivery: "not_queued" });

  assert.match(presentation.message, /not queued/i);
  assert.match(presentation.message, /re-enter/i);
});
