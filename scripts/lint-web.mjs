import { access, constants, readFile } from "node:fs/promises";

const requiredFiles = [
  "web/src/index.html",
  "web/src/main.js",
  "web/src/chat.js",
  "web/src/workspace-layout.js",
  "web/src/auth.js",
  "web/public/manifest.webmanifest",
];

for (const file of requiredFiles) {
  await access(file, constants.R_OK);
}

const [page, app, chat, layout, auth, manifest] = await Promise.all(requiredFiles.map((file) => readFile(file, "utf8")));
const errors = [];

if (!page.includes("manifest.webmanifest") || !page.includes("data-workspace-shell")) {
  errors.push("PWA shell must render the Relay workbench surface");
}
if (!page.includes("id=\"workspace-list\"") || !page.includes("id=\"session-list\"") || !page.includes("id=\"pane-root\"")) {
  errors.push("PWA shell must expose Workspace, Session, and pane entrypoints");
}
if (!app.includes('const WORKBENCH_URL = "/api/workbench"')) {
  errors.push("PWA shell must use the authenticated workbench hub route");
}
if (!app.includes('const STORAGE_KEY = "relay-factory/workbench/v1"')) {
  errors.push("PWA shell must persist the bounded Workspace and recent Session references");
}
if (!app.includes('"/api/sessions/resume"') || !app.includes("renderChatTimeline")) {
  errors.push("PWA shell must wire shared chat rendering and explicit provider resume");
}
if (/WebSocket|Authorization/.test(app)) {
  errors.push("PWA shell must not acquire ambient transport or bearer authority");
}
if (!app.includes("__Host-relay_csrf") || !app.includes("navigator.credentials")) {
  errors.push("PWA shell must invoke the passkey boundary with CSRF protection");
}
if (!chat.includes("eventPresentation") || !chat.includes("renderChatTimeline")) {
  errors.push("shared chat component must handle provider-neutral timeline events");
}
if (/fetch|localStorage|document\.cookie|WebSocket|terminate|sendInput/.test(layout)) {
  errors.push("Workspace layout contract must stay presentation-only and transport-free");
}
if (!auth.includes("recovery_required") || !auth.includes("passkey_denied")) {
  errors.push("PWA auth adapter must expose typed recovery and denied states");
}
if (!manifest.includes('"display": "standalone"')) {
  errors.push("PWA manifest must declare standalone display");
}

if (errors.length > 0) {
  throw new Error(errors.join("; "));
}

console.log("web boundary lint passed");