import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../src/", import.meta.url);

test("the PWA shell is an authenticated CWD workbench, not a layout harness", async () => {
  const [page, app, chat, auth, claude] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("main.js", source), "utf8"),
    readFile(new URL("chat.js", source), "utf8"),
    readFile(new URL("auth.js", source), "utf8"),
    readFile(new URL("claude-workbench.js", source), "utf8"),
  ]);

  assert.match(page, /manifest\.webmanifest/);
  assert.match(page, /data-workspace-shell/);
  assert.match(page, /id="directory-list"/);
  assert.match(page, /id="select-directory"/);
  assert.match(page, /id="workspace-list"/);
  assert.match(page, /id="session-list"/);
  assert.match(page, /id="pane-root"/);
  assert.match(page, /data-layout-action="new-tab"/);
  assert.match(page, /data-layout-action="split-pane"/);
  assert.match(page, /aria-label="Add Project"/);
  assert.match(page, /Sign out this browser/);
  assert.match(page, /id="trusted-browsers"/);
  assert.match(page, /id="passkeys"/);
  assert.match(page, /<svg viewBox="0 0 24 24"/);
  assert.match(page, /font-family: "SFMono-Regular"/);
  assert.doesNotMatch(page, />New tab<|>Split pane<|Presentation is separate/);
  assert.doesNotMatch(page, /border-radius: 999px/);
  assert.match(page, /vendor\/xterm\.js/);
  assert.match(page, /vendor\/xterm\.css/);
  assert.match(page, /terminal-host/);
  assert.doesNotMatch(page, /id="workspace-cwd"|type="file"|showDirectoryPicker/);

  assert.match(app, /const WORKBENCH_URL = "\/api\/workbench"/);
  assert.match(app, /relay-factory\/workbench\/v1/);
  assert.match(app, /relay-factory\/workbench-layouts\/v1/);
  assert.match(app, /"\/api\/workspaces"/);
  assert.match(app, /"\/api\/directories"/);
  assert.doesNotMatch(app, /"\/api\/workspaces\/select"/);
  assert.match(app, /"\/api\/sessions\/resume"/);
  assert.match(app, /"\/api\/sessions\/close"/);
  assert.match(app, /renderChatTimeline/);
  assert.match(app, /new window\.Terminal/);
  assert.match(app, /\/node\/claude\/sessions/);
  assert.match(app, /createTerminalInputQueue/);
  assert.match(app, /if \(updateClaudeSessionStatus\(runtime\.sessionId, snapshot\.status\)\) \{\s*render\(\);\s*return;/);
  assert.match(app, /events: \[\.\.\.\(session\.events \?\? \[\]\), \{ role: "user"/);
  assert.match(app, /moveTab\(/);
  assert.match(app, /setSplitRatio\(/);
  assert.match(app, /aria-label", "Resize panes"/);
  assert.match(app, /__Host-relay_csrf/);
  assert.match(app, /navigator\.credentials\[operation\]/);
  assert.match(app, /recoverExpiredDirectoryBrowse\(error, path\)/);
  assert.match(app, /resumeDirectoryBrowseAfterSignIn\(\)/);
  assert.match(app, /"\/auth\/sign-out"/);
  assert.match(app, /"\/auth\/credentials\/revoke"/);
  assert.doesNotMatch(app, /WebSocket|Authorization/);
  assert.doesNotMatch(app, /showDirectoryPicker|webkitdirectory/);

  assert.match(chat, /function eventPresentation/);
  assert.match(chat, /function renderChatTimeline/);
  assert.match(auth, /recovery_required/);
  assert.match(claude, /serializeRecentClaudeSessions/);
  assert.doesNotMatch(claude, /events: session|output: session/);
});

test("successful malformed or empty JSON responses fail with invalid_response", async () => {
  const app = await readFile(new URL("main.js", source), "utf8");
  const helper = app.match(/async function request\(path, options = \{\}\) \{.*?\n\}(?=\n\nfunction csrfToken)/s)?.[0];
  assert.ok(helper, "request helper must remain available at the web seam");

  for (const message of ["Unexpected end of JSON input", "Unexpected token '<'"]) {
    const fetch = async () => ({
      ok: true,
      json: async () => { throw new SyntaxError(message); },
    });
    const request = Function("fetch", "csrfToken", `"use strict"; ${helper}; return request;`)(fetch, () => "");
    await assert.rejects(
      request("/api/workbench"),
      (error) => error?.code === "invalid_response",
      `successful invalid JSON must reject: ${message}`,
    );
  }
});
