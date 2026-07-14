import assert from "node:assert/strict";
import test from "node:test";

import { eventPresentation, normalizeChatEvents, sessionMayHaveMoreEvents } from "../src/chat.js";

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
  assert.equal(eventPresentation({ role: "system", kind: "error" }).tone, "error");
});

test("assistant deltas coalesce and a cumulative completion replaces the streamed text", () => {
  const events = normalizeChatEvents([
    { role: "assistant", kind: "message", label: "assistant.message.delta", text: "Hel", sequence: 1 },
    { role: "assistant", kind: "message", label: "assistant.message.delta", text: "lo", sequence: 2 },
    { role: "assistant", kind: "message", label: "assistant.message.delta", text: " ", sequence: 3 },
    { role: "assistant", kind: "message", label: "assistant.message.delta", text: "world", sequence: 4 },
    { role: "assistant", kind: "message", label: "assistant.message", text: "Hello world", sequence: 5 },
  ]);

  assert.deepEqual(events, [
    { role: "assistant", kind: "message", label: "assistant.message", text: "Hello world", sequence: 5 },
  ]);
});

test("routine provider status is hidden while errors, approvals, and tools remain", () => {
  const events = normalizeChatEvents([
    { role: "system", kind: "status", label: "session.started", text: "Provider connected" },
    { role: "system", kind: "status", label: "remote_control.status", text: "remote control status" },
    { role: "system", kind: "status", label: "turn.started", text: "turn started" },
    { role: "system", kind: "status", label: "approval.request", text: "Approval required" },
    { role: "system", kind: "error", label: "provider.error", text: "Provider failed", signal: "degraded" },
    { role: "system", kind: "tool", label: "tool.started", text: "tool search" },
  ]);

  assert.deepEqual(events.map(({ label }) => label), ["approval.request", "provider.error", "tool.started"]);
});

test("a non-streamed completed assistant message is never dropped", () => {
  assert.deepEqual(normalizeChatEvents([
    { role: "assistant", kind: "message", label: "assistant.message", text: "Complete answer" },
  ]), [
    { role: "assistant", kind: "message", label: "assistant.message", text: "Complete answer" },
  ]);
});

test("nonterminal degraded sessions keep polling for later provider events", () => {
  assert.equal(sessionMayHaveMoreEvents({ status: "starting" }), true);
  assert.equal(sessionMayHaveMoreEvents({ status: "working" }), true);
  assert.equal(sessionMayHaveMoreEvents({ status: "degraded" }), true);
  assert.equal(sessionMayHaveMoreEvents({ status: "idle" }), false);
  assert.equal(sessionMayHaveMoreEvents({ status: "error" }), false);
  assert.equal(sessionMayHaveMoreEvents(undefined), false);
});
