import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../src/", import.meta.url);

test("the PWA shell consumes only the hub liveness boundary", async () => {
  const [page, app] = await Promise.all([
    readFile(new URL("index.html", source), "utf8"),
    readFile(new URL("main.js", source), "utf8"),
  ]);

  assert.match(page, /manifest\.webmanifest/);
  assert.match(app, /http:\/\/127\.0\.0\.1:8787\/health/);
  assert.match(app, /health\.service !== "hub"/);
  assert.doesNotMatch(app, /localStorage|document\.cookie|WebSocket|\/api\//);
});
