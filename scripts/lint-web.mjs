import { access, constants, readFile } from "node:fs/promises";

const requiredFiles = [
  "web/src/index.html",
  "web/src/main.js",
  "web/src/workspace-layout.js",
  "web/public/manifest.webmanifest",
];

for (const file of requiredFiles) {
  await access(file, constants.R_OK);
}

const [page, app, layout, manifest] = await Promise.all(requiredFiles.map((file) => readFile(file, "utf8")));
const errors = [];

if (!page.includes("manifest.webmanifest") || !page.includes("data-workspace-shell")) {
  errors.push("PWA shell must render the versioned Workspace presentation surface");
}
if (!app.includes('const HEALTH_URL = "http://127.0.0.1:8787/health"')) {
  errors.push("PWA shell must use the documented liveness boundary");
}
if (!app.includes('const STORAGE_KEY = "relay-factory/workspace-layout/v1"')) {
  errors.push("PWA shell must scope persistence to the versioned layout key");
}
if (!app.includes("serializeWorkspaceLayout") || !app.includes("setNodeAvailability")) {
  errors.push("PWA shell must persist only layout state and render typed Node availability");
}
if (/document\.cookie|WebSocket|\/api\/|sendInput|terminate/.test(app)) {
  errors.push("PWA shell must not acquire Session or transport control authority");
}
if (/fetch|localStorage|document\.cookie|WebSocket|sendInput|terminate|ProcessTransport/.test(layout)) {
  errors.push("Workspace layout contract must stay presentation-only and transport-free");
}
if (!manifest.includes('"display": "standalone"')) {
  errors.push("PWA manifest must declare standalone display");
}

if (errors.length > 0) {
  throw new Error(errors.join("; "));
}

console.log("web boundary lint passed");
