import { access, constants, readFile } from "node:fs/promises";

const requiredFiles = [
  "web/src/index.html",
  "web/src/main.js",
  "web/src/auth.js",
  "web/public/manifest.webmanifest",
];

for (const file of requiredFiles) {
  await access(file, constants.R_OK);
}

const [page, app, auth, manifest] = await Promise.all(requiredFiles.map((file) => readFile(file, "utf8")));
const errors = [];

if (!page.includes("manifest.webmanifest")) {
  errors.push("PWA shell must link its manifest");
}
if (!app.includes('const HEALTH_URL = "http://127.0.0.1:8787/health"')) {
  errors.push("PWA shell must use the documented liveness boundary");
}
if (!app.includes("__Host-relay_csrf") || !app.includes("navigator.credentials")) {
  errors.push("PWA shell must invoke only the passkey boundary with CSRF protection");
}
if (/localStorage|WebSocket|\/api\/|Authorization:/.test(app)) {
  errors.push("PWA shell must not acquire ambient product or node authority");
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
