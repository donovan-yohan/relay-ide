import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../src/", import.meta.url);

test("the PWA shell combines passkey controls with a presentation-only Workspace layout", async () => {
  const [page, app, layout, auth] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("main.js", source), "utf8"),
    readFile(new URL("workspace-layout.js", source), "utf8"),
    readFile(new URL("auth.js", source), "utf8"),
  ]);

  assert.match(page, /manifest\.webmanifest/);
  assert.match(page, /data-workspace-shell/);
  assert.match(page, /id="enroll-passkey"/);
  assert.match(page, /id="sign-in"/);
  assert.match(page, /id="trusted-devices"/);
  assert.match(page, /Node credentials remain separate/);
  assert.match(app, /http:\/\/127\.0\.0\.1:8787\/health/);
  assert.match(app, /workspace-layout\.js/);
  assert.match(app, /localStorage/);
  assert.match(app, /fetch\(HEALTH_URL\)/);
  assert.ok(
    app.indexOf("if (!response.ok)") < app.indexOf("const health = await response.json()"),
    "non-OK liveness responses must fail before JSON parsing",
  );
  assert.match(app, /pane && pane\.dataset\.selectPane !== state\.selectedPaneId/);
  assert.match(app, /transientNotice \? \(transientNotice\.title \?\? "Layout action"\) : "Layout recovery"/);
  assert.match(app, /__Host-relay_csrf/);
  assert.match(app, /function renderTrustedDevices/);
  assert.match(app, /function revokeSession/);
  assert.match(app, /navigator\.credentials\[operation\]/);
  assert.match(auth, /recovery_required/);
  assert.doesNotMatch(app, /WebSocket|Authorization/);
  assert.doesNotMatch(layout, /fetch|localStorage|document\.cookie|WebSocket|terminate|sendInput/);
  assert.doesNotMatch(page, /PIN.*sign-in/i);
});
