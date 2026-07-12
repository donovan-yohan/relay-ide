import assert from "node:assert/strict";
import test from "node:test";

import { eventPresentation } from "../src/chat.js";

test("one shared chat timeline gives provider-neutral event roles stable, honest presentations", () => {
  assert.deepEqual(eventPresentation({ role: "user", label: "message.sent", text: "hello" }), {
    tone: "user",
    roleLabel: "You",
    eventLabel: "message.sent",
    text: "hello",
  });
  assert.deepEqual(eventPresentation({ role: "assistant", label: "item.started", text: "Provider activity." }), {
    tone: "assistant",
    roleLabel: "Assistant",
    eventLabel: "item.started",
    text: "Provider activity.",
  });
  assert.deepEqual(eventPresentation({ role: "tool", label: "tool_progress", text: "tool activity" }), {
    tone: "tool",
    roleLabel: "Tool",
    eventLabel: "tool_progress",
    text: "tool activity",
  });
  assert.equal(eventPresentation({ role: "unknown" }).roleLabel, "Status");
  assert.equal(eventPresentation({ role: "unknown" }).eventLabel, "session.update");
});