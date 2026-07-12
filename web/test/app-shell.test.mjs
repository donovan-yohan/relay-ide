import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../src/", import.meta.url);

test("the PWA shell exposes typed passkey and node-boundary states", async () => {
  const [page, app, auth] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("main.js", source), "utf8"),
    readFile(new URL("auth.js", source), "utf8"),
  ]);

  assert.match(page, /manifest\.webmanifest/);
  assert.match(page, /id="enroll-passkey"/);
  assert.match(page, /id="sign-in"/);
  assert.match(page, /id="trusted-devices"/);
  assert.match(page, /Node credentials remain separate/);
  assert.match(app, /http:\/\/127\.0\.0\.1:8787\/health/);
  assert.match(app, /__Host-relay_csrf/);
  assert.match(app, /function renderTrustedDevices/);
  assert.match(app, /function revokeSession/);
  assert.match(app, /navigator\.credentials\[operation\]/);
  assert.match(auth, /recovery_required/);
  assert.doesNotMatch(app, /localStorage|WebSocket|\/api\/|Authorization:/);
  assert.doesNotMatch(page, /PIN.*sign-in/i);
});
