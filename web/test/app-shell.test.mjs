import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../src/", import.meta.url);

test("the PWA shell keeps Workspace layout presentation separate from Session control", async () => {
  const [page, app, layout] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("main.js", source), "utf8"),
    readFile(new URL("workspace-layout.js", source), "utf8"),
  ]);

  assert.match(page, /manifest\.webmanifest/);
  assert.match(page, /data-workspace-shell/);
  assert.match(app, /http:\/\/127\.0\.0\.1:8787\/health/);
  assert.match(app, /workspace-layout\.js/);
  assert.match(app, /localStorage/);
  assert.match(app, /fetch\(HEALTH_URL\)/);
  assert.doesNotMatch(app, /document\.cookie|WebSocket|\/api\/|terminate|sendInput/);
  assert.doesNotMatch(layout, /fetch|localStorage|document\.cookie|WebSocket|terminate|sendInput/);
});
