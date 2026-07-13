import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RECENT_CLAUDE_SESSIONS,
  mergeRecentClaudeSessions,
  restoreRecentClaudeSessions,
  serializeRecentClaudeSessions,
  sessionSurface,
} from "../src/claude-workbench.js";

function claudeSession(index = 1) {
  return {
    id: `claude-session-${index}`,
    workspaceId: "workspace-live",
    workspaceCwd: "/approved/project",
    provider: "claude",
    providerSessionId: `claude-pty-${index}`,
    status: "running",
    title: "Claude Code",
    events: [{ text: "raw terminal bytes must not persist" }],
    output: "secret terminal output",
  };
}

test("chat Sessions and Claude Sessions select distinct pane surfaces", () => {
  assert.equal(sessionSurface({ provider: "codex" }), "chat");
  assert.equal(sessionSurface({ provider: "hermes" }), "chat");
  assert.equal(sessionSurface(claudeSession()), "terminal");
});

test("recent Claude metadata persistence is bounded and excludes terminal bytes and events", () => {
  const sessions = Array.from({ length: MAX_RECENT_CLAUDE_SESSIONS + 3 }, (_, index) => claudeSession(index + 1));
  const serialized = serializeRecentClaudeSessions(sessions);
  const raw = JSON.parse(serialized);

  assert.equal(raw.length, MAX_RECENT_CLAUDE_SESSIONS);
  assert.deepEqual(Object.keys(raw[0]).sort(), [
    "id",
    "provider",
    "providerSessionId",
    "status",
    "title",
    "workspaceCwd",
  ]);
  assert.doesNotMatch(serialized, /raw terminal bytes|secret terminal output|events|output/);
  assert.deepEqual(restoreRecentClaudeSessions(serialized), raw);
});

test("restored Claude metadata reopens by opaque PTY id and remains stale-candidate until runtime polling", () => {
  const recent = restoreRecentClaudeSessions(serializeRecentClaudeSessions([claudeSession()]));
  const merged = mergeRecentClaudeSessions([], recent, {
    id: "workspace-restored",
    cwd: "/approved/project",
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].workspaceId, "workspace-restored");
  assert.equal(merged[0].providerSessionId, "claude-pty-1");
  assert.equal(merged[0].staleCandidate, true);
  assert.deepEqual(merged[0].events, []);
});

test("malformed or secret-bearing persisted records are discarded", () => {
  assert.deepEqual(restoreRecentClaudeSessions("not json"), []);
  assert.deepEqual(restoreRecentClaudeSessions(JSON.stringify([{ ...claudeSession(), providerSessionId: "../../secret" }])), []);
  assert.deepEqual(restoreRecentClaudeSessions(JSON.stringify([{ ...claudeSession(), title: "x".repeat(97) }])), []);
});
