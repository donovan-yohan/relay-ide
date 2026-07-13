import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";

import {
  devToolsEndpointFromActivePort,
  devToolsEndpointFromOutput,
} from "./cdp-endpoint.mjs";


const chromium = "/usr/bin/chromium";
const recoveryCode = "browser-virtual-authenticator-recovery";
const root = resolve("web/src");
const publicRoot = resolve("web/public");
const xtermRoot = resolve("node_modules/@xterm/xterm");
const scratch = await mkdtemp(`${tmpdir()}/relay-passkey-browser-`);
const chromeProfile = resolve(scratch, "chrome-profile");
const recoveryHash = createHash("sha256").update(recoveryCode).digest("hex");
const httpsPort = await reservePort();
const origin = `https://relay.test:${httpsPort}`;
let hub;
let proxy;
let chromiumProcess;
let browser;

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve_, reject) => {
      socket.addEventListener("open", resolve_, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", (message) => {
      const response = JSON.parse(message.data);
      const pending = this.pending.get(response.id);
      if (!pending) {
        this.events.push(response);
        return;
      }
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
    });
  }

  command(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve_, reject) => this.pending.set(id, { resolve: resolve_, reject }));
  }

  close() {
    this.socket.close();
  }
}

if (spawnSync(chromium, ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log("passkey browser matrix skipped: Chromium is unavailable");
  process.exit(0);
}

try {
  await createCertificate();
  hub = startHub();
  const hubAddress = await waitForHub(hub);
  proxy = await startProxy(hubAddress.port);
  chromiumProcess = spawn(
    chromium,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${chromeProfile}`,
      "--ignore-certificate-errors",
      "--host-resolver-rules=MAP relay.test 127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  browser = await connectBrowser(chromiumProcess, captureProcessOutput(chromiumProcess), chromeProfile);
  const { sessionId } = await createIndependentBrowser();

  await evaluate(
    sessionId,
    `Object.defineProperty(navigator.credentials, "create", { configurable: true, value: async () => null });`,
  );
  assert.equal(
    await recoveryValueAfterFailedEnrollment(sessionId),
    "",
    "recovery code must clear when WebAuthn enrollment returns no credential",
  );
  await evaluate(sessionId, "delete navigator.credentials.create");
  await evaluate(
    sessionId,
    `Object.defineProperty(navigator.credentials, "create", { configurable: true, value: async () => { throw new DOMException("denied", "NotAllowedError"); } });`,
  );
  assert.equal(
    await recoveryValueAfterFailedEnrollment(sessionId),
    "",
    "recovery code must clear when WebAuthn enrollment rejects",
  );
  await evaluate(sessionId, "delete navigator.credentials.create");
  await evaluate(
    sessionId,
    `window.relayOriginalFetch = window.fetch; window.fetch = async (input, init) => { if (new URL(typeof input === "string" ? input : input.url, window.location.href).pathname === "/auth/passkeys/enroll/options") throw new TypeError("network unavailable"); return window.relayOriginalFetch(input, init); };`,
  );
  assert.equal(
    await recoveryValueAfterFailedEnrollment(sessionId),
    "",
    "recovery code must clear when enrollment options fail over the network",
  );
  await evaluate(sessionId, "window.fetch = window.relayOriginalFetch; delete window.relayOriginalFetch");

  await evaluate(
    sessionId,
    `document.querySelector("#recovery-code").value = ${JSON.stringify(recoveryCode)}; document.querySelector("#enroll-passkey").click();`,
  );
  await waitFor(async () => (await evaluate(sessionId, "document.querySelector('#auth-status').textContent"))?.includes("Passkey enrolled"));

  await evaluate(sessionId, "document.querySelector('#sign-in').click()");
  await waitFor(async () => (await evaluate(sessionId, "document.querySelector('#auth-status').textContent"))?.includes("Browser access verified"));
  await browser.command("Log.enable", {}, sessionId);
  assert.equal(
    await evaluate(sessionId, "fetch('/protected/hub', { credentials: 'same-origin' }).then((response) => response.status)"),
    200,
    "a verified passkey must authorize the protected hub route",
  );
  const { cookies } = await browser.command("Network.getAllCookies", {}, sessionId);
  const sessionCookie = cookies.find((cookie) => cookie.name === "__Host-relay_session")?.value;
  assert.ok(sessionCookie, "a verified passkey must create an HttpOnly browser session cookie");
  assert.equal(
    await protectedHubStatus(hubAddress.port, sessionCookie),
    200,
    "a valueless unrelated Cookie segment must not invalidate a valid browser session",
  );

  const workspaceId = await addProjectThroughPicker(sessionId, process.cwd());
  const { sessionId: secondSessionId } = await createIndependentBrowser();
  await enrollAndSignIn(secondSessionId);
  await waitFor(async () => (await evaluate(secondSessionId, "document.querySelectorAll('#workspace-list button').length")) === 1);
  assert.equal(
    await evaluate(secondSessionId, "fetch('/api/workbench', { credentials: 'same-origin' }).then((response) => response.json()).then((snapshot) => snapshot.workspaces[0].id)"),
    workspaceId,
    "an independent authenticated browser context must see the same Project catalog",
  );

  const nestedCwd = resolve("web");
  const nestedWorkspaceId = await postJson(sessionId, "/api/workspaces", { cwd: nestedCwd })
    .then((response) => response.body.id);
  assert.match(nestedWorkspaceId, /^workspace-\d+$/);
  await reloadWorkbench(secondSessionId, 2);
  assert.equal(
    await evaluate(secondSessionId, "document.querySelectorAll('#workspace-list button').length"),
    2,
    "a Project added by browser A must appear for browser B",
  );

  const terminalApi = await evaluate(
    sessionId,
    `(async () => {
      const workspaceId = ${JSON.stringify(workspaceId)};
      const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("__Host-relay_csrf="))?.slice("__Host-relay_csrf=".length);
      const request = async (path, body) => {
        const response = await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Relay-CSRF": csrf },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const unknownWorkspace = await request("/node/claude/sessions", { workspaceId: "workspace-unknown" });
      const created = await request("/node/claude/sessions", { workspaceId });
      const terminalId = created.body.sessionId;
      const resize = await request("/node/claude/sessions/" + terminalId + "/resize", { cols: 92, rows: 28 });
      const input = await request("/node/claude/sessions/" + terminalId + "/input", { data: "browser-api\\n" });
      let poll = { status: 0, body: { output: [] } };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await fetch("/node/claude/sessions/" + terminalId + "?trace=browser-smoke&cursor=0", { credentials: "same-origin" });
        poll = { status: response.status, body: await response.json() };
        if (poll.body.output.some((chunk) => chunk.text.includes("browser-api"))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const interrupt = await request("/node/claude/sessions/" + terminalId + "/interrupt", {});
      const close = await request("/node/claude/sessions/" + terminalId + "/close", {});
      let closed = close;
      for (let attempt = 0; !["closed", "exited"].includes(closed.body.status) && attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const response = await fetch("/node/claude/sessions/" + terminalId + "?cursor=0", { credentials: "same-origin" });
        closed = { status: response.status, body: await response.json() };
      }
      const replacement = await request("/node/claude/sessions", { workspaceId });
      const replacementClose = await request("/node/claude/sessions/" + replacement.body.sessionId + "/close", {});
      return { unknownWorkspace, created, resize, input, poll, interrupt, close, closed, replacement, replacementClose };
    })()`,
  );
  assert.equal(terminalApi.unknownWorkspace.status, 404, "unknown Workspace ids must fail before PTY spawn");
  assert.equal(terminalApi.unknownWorkspace.body.error.code, "unknown_workspace");
  assert.equal(terminalApi.created.status, 200, "authenticated browser authority must create the bounded PTY through the node route");
  assert.match(terminalApi.created.body.sessionId, /^claude-pty-\d+$/, "the browser receives only an opaque PTY Session ID");
  assert.equal(terminalApi.created.body.workbenchSession.provider, "claude");
  assert.equal(terminalApi.created.body.workbenchSession.workspaceId, workspaceId);
  assert.equal(terminalApi.resize.status, 200, "authenticated resize must reach the shared PTY");
  assert.equal(terminalApi.input.status, 200, "authenticated input must reach the shared PTY");
  assert.ok(
    terminalApi.poll.body.output.some((chunk) => chunk.text.includes("browser-api")),
    "the direct browser API seam must return bounded PTY output",
  );
  assert.equal(terminalApi.interrupt.status, 200, "interrupt must not imply terminal close");
  assert.ok([200, 202].includes(terminalApi.close.status), "explicit close must enter the retained teardown lifecycle");
  assert.equal(terminalApi.closed.body.status, "closed", "autonomous retries must make terminal closure observable without another mutation");
  assert.equal(terminalApi.replacement.status, 200, "reaped capacity must admit a replacement PTY before auth revocation");
  assert.notEqual(terminalApi.replacement.body.sessionId, terminalApi.created.body.sessionId);
  assert.ok([200, 202].includes(terminalApi.replacementClose.status), "replacement PTY must be explicitly closed");

  await exerciseVisibleClaudeWorkbench(sessionId);

  if (process.env.RELAY_WORKBENCH_LIVE === "1") {
    const liveEventOffset = browser.events.length;
    await exerciseLiveWorkbench(sessionId);
    const pageErrors = browser.events.slice(liveEventOffset).filter((event) => (
      event.method === "Runtime.exceptionThrown"
      || (event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
      || (event.method === "Log.entryAdded" && event.params.entry.level === "error")
    ));
    assert.deepEqual(pageErrors, [], "the live workbench path must not emit page or console errors");
  }

  await exerciseCrossBrowserTerminal(secondSessionId, sessionId, workspaceId, "browser-a-operated");
  const retainedTerminal = await createTerminal(sessionId, workspaceId);
  const concurrentInputs = await Promise.all([
    postJson(sessionId, `/node/claude/sessions/${retainedTerminal}/input`, { data: "from-browser-a\n" }),
    postJson(secondSessionId, `/node/claude/sessions/${retainedTerminal}/input`, { data: "from-browser-b\n" }),
  ]);
  assert.deepEqual(concurrentInputs.map((response) => response.status), [200, 200]);
  const sharedOutput = await pollTerminal(secondSessionId, retainedTerminal, ["from-browser-a", "from-browser-b"]);
  assert.ok(sharedOutput.includes("from-browser-a") && sharedOutput.includes("from-browser-b"));
  const secondCookies = (await browser.command("Network.getCookies", { urls: [origin] }, secondSessionId)).cookies;
  const secondSessionCookie = secondCookies.find((cookie) => cookie.name === "__Host-relay_session")?.value;
  const secondCsrf = secondCookies.find((cookie) => cookie.name === "__Host-relay_csrf")?.value;
  assert.ok(secondSessionCookie && secondCsrf, "browser B must retain bounded session and CSRF cookies");
  for (const [path, body] of [
    ["/auth/sign-out", {}],
    ["/auth/sessions/revoke", { deviceId: "unknown-device" }],
    ["/api/workspaces/select", { workspaceId }],
    [`/node/claude/sessions/${retainedTerminal}/input`, { data: "denied\n" }],
  ]) {
    assert.equal(
      await hubMutationStatus(hubAddress.port, path, secondSessionCookie, secondCsrf, "https://wrong.example.test", body),
      403,
      `${path} must reject a wrong mutation Origin`,
    );
  }
  assert.equal(
    await hubMutationStatus(hubAddress.port, `/node/claude/sessions/${retainedTerminal}/input`, secondSessionCookie, "wrong-csrf", origin, { data: "denied\n" }),
    403,
    "PTY mutation must reject stale CSRF",
  );

  await reloadWorkbench(sessionId, 2);
  await reloadWorkbench(secondSessionId, 2);
  await evaluate(sessionId, "document.querySelector('#workspace-list button').click()");
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('.workbench-pane').length")) === 1);
  await evaluate(sessionId, "document.querySelector('[data-layout-action=\"split-pane\"]').click()");
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('.workbench-pane').length")) === 2);
  await evaluate(
    secondSessionId,
    `[...document.querySelectorAll('#workspace-list button')].find((button) => button.querySelector('.sidebar-item__meta')?.textContent === ${JSON.stringify(nestedCwd)}).click()`,
  );
  await waitFor(async () => (await evaluate(secondSessionId, "document.querySelectorAll('.workbench-pane').length")) === 0);
  await Promise.all([reloadWorkbench(sessionId, 2), reloadWorkbench(secondSessionId, 2)]);
  assert.deepEqual(
    await evaluate(sessionId, "({ selected: document.querySelector('#workspace-list [aria-current=\"page\"] .sidebar-item__meta')?.textContent, panes: document.querySelectorAll('.workbench-pane').length })"),
    { selected: process.cwd(), panes: 2 },
    "browser A selection and split layout must restore from only browser A storage",
  );
  assert.deepEqual(
    await evaluate(secondSessionId, "({ selected: document.querySelector('#workspace-list [aria-current=\"page\"] .sidebar-item__meta')?.textContent, panes: document.querySelectorAll('.workbench-pane').length })"),
    { selected: nestedCwd, panes: 0 },
    "browser B selection must remain independent from browser A layout",
  );

  const firstCredentialId = await evaluate(
    sessionId,
    "fetch('/auth/sessions', { credentials: 'same-origin' }).then((response) => response.json()).then((security) => security.sessions.find((browser) => browser.current).credentialId)",
  );
  await evaluate(sessionId, "document.querySelector('#sign-out').click()");
  await waitFor(async () => (await evaluate(sessionId, "fetch('/protected/hub', { credentials: 'same-origin' }).then((response) => response.status)")) === 401);
  assert.equal(
    await evaluate(sessionId, "fetch('/api/workbench', { credentials: 'same-origin' }).then((response) => response.status)"),
    401,
    "signed-out browser A must fail closed on shared catalog reads",
  );
  assert.equal(
    (await postJson(sessionId, `/node/claude/sessions/${retainedTerminal}/input`, { data: "revoked-input\n" })).status,
    401,
    "signed-out browser A must fail closed on shared PTY mutations",
  );
  assert.equal(
    await evaluate(secondSessionId, "fetch('/protected/hub', { credentials: 'same-origin' }).then((response) => response.status)"),
    200,
    "signing out browser A must leave browser B authenticated",
  );
  const retainedCatalog = await evaluate(
    secondSessionId,
    "fetch('/api/workbench', { credentials: 'same-origin' }).then((response) => response.json())",
  );
  assert.equal(retainedCatalog.workspaces.length, 2, "browser sign-out must retain shared Projects");
  assert.ok(
    retainedCatalog.sessions.some((session) => session.providerSessionId === retainedTerminal),
    "browser sign-out must retain shared terminal metadata",
  );
  await postJson(secondSessionId, `/node/claude/sessions/${retainedTerminal}/resize`, { cols: 88, rows: 26 });
  await postJson(secondSessionId, `/node/claude/sessions/${retainedTerminal}/input`, { data: "after-sign-out\n" });
  await pollTerminal(secondSessionId, retainedTerminal, ["after-sign-out"]);
  await postJson(secondSessionId, `/node/claude/sessions/${retainedTerminal}/interrupt`, {});
  await closeTerminal(secondSessionId, retainedTerminal);

  await recoverExpiredProjectBrowse(sessionId, process.cwd());
  const credentialRevoke = await postJson(secondSessionId, "/auth/credentials/revoke", {
    credentialId: firstCredentialId,
  });
  assert.equal(credentialRevoke.status, 200, "browser B must revoke browser A's compromised passkey");
  assert.equal(
    await evaluate(sessionId, "fetch('/protected/hub', { credentials: 'same-origin' }).then((response) => response.status)"),
    401,
    "credential revocation must immediately fail closed for browser A",
  );
  const secondSecurity = await evaluate(
    secondSessionId,
    "fetch('/auth/sessions', { credentials: 'same-origin' }).then((response) => response.json())",
  );
  assert.equal(secondSecurity.sessions.length, 1, "credential revocation must retain browser B only");
  assert.equal(secondSecurity.credentials.length, 1, "credential revocation must retain browser B's passkey");
  assert.ok(secondSecurity.audit.some((event) => event.action === "session.revoked"));
  assert.ok(secondSecurity.audit.some((event) => event.action === "credential.revoked" && event.targetId === firstCredentialId));
  assert.equal(
    await evaluate(secondSessionId, "fetch('/protected/node', { credentials: 'same-origin' }).then((response) => response.status)"),
    403,
    "a browser session must never become node authority",
  );
  assert.match(
    hubAddress.output(),
    /^relay-hub liveness listening on 127\.0\.0\.1:\d+\n$/,
    "the real WebAuthn enrollment, assertion, session, and revoke path must not append credential or session material to hub logs",
  );
  console.log("passkey browser matrix passed with Chromium CDP virtual authenticator");
} finally {
  browser?.close();
  proxy?.close();
  if (hub?.exitCode === null) hub.kill("SIGTERM");
  if (chromiumProcess?.exitCode === null) chromiumProcess.kill("SIGTERM");
}

function startHub() {
  return spawn(
    "cargo",
    [
      "run",
      "--quiet",
      "-p",
      "relay-hub",
      "--",
      "serve",
      "--bind",
      "127.0.0.1:0",
      "--origin",
      origin,
      "--recovery-code-hash",
      recoveryHash,
      "--test-claude-fixture",
      "cat",
      "--workspace-root",
      process.cwd(),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function createIndependentBrowser() {
  const { browserContextId } = await browser.command("Target.createBrowserContext");
  const { targetId } = await browser.command("Target.createTarget", {
    url: "about:blank",
    browserContextId,
  });
  const { sessionId } = await browser.command("Target.attachToTarget", { targetId, flatten: true });
  await browser.command("Page.enable", {}, sessionId);
  await browser.command("Runtime.enable", {}, sessionId);
  await browser.command("WebAuthn.enable", {}, sessionId);
  await browser.command(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
    sessionId,
  );
  await browser.command("Page.navigate", { url: `${origin}/` }, sessionId);
  await waitFor(async () => (await evaluate(sessionId, "document.readyState")) === "complete");
  return { browserContextId, sessionId };
}

async function waitForHub(process_) {
  let output = "";
  process_.stdout.setEncoding("utf8");
  process_.stderr.setEncoding("utf8");
  process_.stdout.on("data", (chunk) => {
    output += chunk;
  });
  process_.stderr.on("data", (chunk) => {
    output += chunk;
  });
  await waitFor(() => {
    const match = output.match(/relay-hub liveness listening on 127\.0\.0\.1:(\d+)/);
    if (match) return { port: Number(match[1]) };
    if (process_.exitCode !== null) throw new Error(`hub exited before startup: ${output}`);
    return false;
  });
  return {
    output: () => output,
    port: Number(output.match(/relay-hub liveness listening on 127\.0\.0\.1:(\d+)/)[1]),
  };
}

async function protectedHubStatus(port, sessionCookie) {
  return new Promise((resolve_, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/protected/hub",
        headers: { Cookie: `__Host-relay_session=${sessionCookie}; legacy` },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve_(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function hubMutationStatus(port, path, sessionCookie, csrf, requestOrigin, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve_, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Cookie: `__Host-relay_session=${sessionCookie}; __Host-relay_csrf=${csrf}`,
          Origin: requestOrigin,
          "X-Relay-CSRF": csrf,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve_(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

async function recoveryValueAfterFailedEnrollment(sessionId) {
  await evaluate(
    sessionId,
    `document.querySelector("#auth-status").textContent = ""; document.querySelector("#recovery-code").value = ${JSON.stringify(recoveryCode)}; document.querySelector("#enroll-passkey").click();`,
  );
  await waitFor(async () => Boolean(await evaluate(sessionId, "document.querySelector('#auth-status').textContent")));
  return evaluate(sessionId, "document.querySelector('#recovery-code').value");
}

async function enrollAndSignIn(sessionId) {
  await evaluate(
    sessionId,
    `document.querySelector("#recovery-code").value = ${JSON.stringify(recoveryCode)}; document.querySelector("#enroll-passkey").click();`,
  );
  await waitFor(async () => (await evaluate(sessionId, "document.querySelector('#auth-status').textContent"))?.includes("Passkey enrolled"));
  await evaluate(sessionId, "document.querySelector('#sign-in').click()");
  await waitFor(async () => (await evaluate(sessionId, "document.querySelector('#auth-status').textContent"))?.includes("Browser access verified"));
}

async function postJson(sessionId, path, body) {
  return evaluate(
    sessionId,
    `(async () => {
      const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("__Host-relay_csrf="))?.slice("__Host-relay_csrf=".length);
      const response = await fetch(${JSON.stringify(path)}, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Relay-CSRF": csrf },
        body: ${JSON.stringify(JSON.stringify(body))},
      });
      return { status: response.status, body: await response.json() };
    })()`,
  );
}

async function reloadWorkbench(sessionId, workspaceCount) {
  await browser.command("Page.reload", { ignoreCache: true }, sessionId);
  await waitFor(async () => (await evaluate(sessionId, "document.readyState")) === "complete");
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelectorAll('#workspace-list button').length")) === workspaceCount,
    async () => evaluate(sessionId, "({ auth: document.querySelector('#auth-status').textContent, error: document.querySelector('#workbench-error').textContent, workspaces: document.querySelectorAll('#workspace-list button').length })"),
  );
}

async function createTerminal(sessionId, workspaceId) {
  const created = await postJson(sessionId, "/node/claude/sessions", { workspaceId });
  assert.equal(created.status, 200, "authenticated browser must create a shared terminal");
  return created.body.sessionId;
}

async function pollTerminal(sessionId, terminalId, expectedText) {
  return waitFor(
    async () => {
      const result = await evaluate(
        sessionId,
        `fetch(${JSON.stringify(`/node/claude/sessions/${terminalId}?cursor=0`)}, { credentials: "same-origin" }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
      );
      const output = (result.body.output ?? []).map((chunk) => chunk.text).join("");
      return result.status === 200 && expectedText.every((text) => output.includes(text)) ? output : false;
    },
    `terminal output containing ${expectedText.join(", ")}`,
  );
}

async function closeTerminal(sessionId, terminalId) {
  const requested = await postJson(sessionId, `/node/claude/sessions/${terminalId}/close`, {});
  assert.ok([200, 202].includes(requested.status), "shared terminal close must be accepted");
  await waitFor(async () => {
    const snapshot = await evaluate(
      sessionId,
      `fetch(${JSON.stringify(`/node/claude/sessions/${terminalId}?cursor=0`)}, { credentials: "same-origin" }).then((response) => response.json())`,
    );
    return ["closed", "exited"].includes(snapshot.status);
  }, "shared terminal closure");
}

async function exerciseCrossBrowserTerminal(creatorSessionId, operatorSessionId, workspaceId, input) {
  const terminalId = await createTerminal(creatorSessionId, workspaceId);
  const shared = await evaluate(
    operatorSessionId,
    `fetch('/api/workbench', { credentials: 'same-origin' }).then((response) => response.json()).then((snapshot) => snapshot.sessions.some((session) => session.providerSessionId === ${JSON.stringify(terminalId)}))`,
  );
  assert.equal(shared, true, "another authenticated browser must observe the shared terminal Session");
  assert.equal((await postJson(operatorSessionId, `/node/claude/sessions/${terminalId}/resize`, { cols: 90, rows: 25 })).status, 200);
  assert.equal((await postJson(operatorSessionId, `/node/claude/sessions/${terminalId}/input`, { data: `${input}\n` })).status, 200);
  await pollTerminal(operatorSessionId, terminalId, [input]);
  assert.equal((await postJson(operatorSessionId, `/node/claude/sessions/${terminalId}/interrupt`, {})).status, 200);
  await closeTerminal(operatorSessionId, terminalId);
}

async function addProjectThroughPicker(sessionId, cwd) {
  const previousCount = await evaluate(sessionId, "document.querySelectorAll('#workspace-list button').length");
  await evaluate(sessionId, "document.querySelector('#show-workspace-add').click()");
  await waitFor(
    async () => evaluate(
      sessionId,
      `[...document.querySelectorAll('#directory-list [data-directory-path]')].some((button) => button.dataset.directoryPath === ${JSON.stringify(cwd)})`,
    ),
    async () => evaluate(sessionId, "({ path: document.querySelector('#directory-path').textContent, error: document.querySelector('#workbench-error').textContent, directories: [...document.querySelectorAll('#directory-list [data-directory-path]')].map((button) => button.dataset.directoryPath) })"),
  );
  await evaluate(
    sessionId,
    `[...document.querySelectorAll('#directory-list [data-directory-path]')].find((button) => button.dataset.directoryPath === ${JSON.stringify(cwd)}).click()`,
  );
  await waitFor(async () => (await evaluate(sessionId, "document.querySelector('#directory-path').textContent")) === cwd);
  await evaluate(sessionId, "document.querySelector('#select-directory').click()");
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('#workspace-list button').length")) === previousCount + 1);
  return evaluate(
    sessionId,
    `fetch('/api/workbench', { credentials: 'same-origin' }).then((response) => response.json()).then((snapshot) => snapshot.workspaces.find((workspace) => workspace.cwd === ${JSON.stringify(cwd)})?.id)`,
  );
}

async function recoverExpiredProjectBrowse(sessionId, cwd) {
  await evaluate(sessionId, "document.querySelector('#show-workspace-add').click()");
  await waitFor(
    async () => ["session_missing", "csrf_denied"].includes(
      await evaluate(sessionId, "document.querySelector('#workbench-error').dataset.code"),
    ),
    async () => evaluate(sessionId, "({ auth: document.querySelector('#auth-status').textContent, error: document.querySelector('#workbench-error').textContent, code: document.querySelector('#workbench-error').dataset.code })"),
  );
  const lockedState = await evaluate(
    sessionId,
    "({ pickerHidden: document.querySelector('#workspace-add').hidden, accessOpen: document.querySelector('.auth-compact').open, focused: document.activeElement?.id, state: document.querySelector('#session-status').dataset.state, auth: document.querySelector('#auth-status').textContent })",
  );
  const { auth, ...lockedUi } = lockedState;
  assert.deepEqual(
    lockedUi,
    { pickerHidden: true, accessOpen: true, focused: "sign-in", state: "unknown" },
    "expired Project browse must lock the workbench and expose focused passkey recovery",
  );
  assert.match(auth, /Sign in again to continue adding this Project\./);

  await evaluate(sessionId, "document.querySelector('#sign-in').click()");
  await waitFor(
    async () => evaluate(
      sessionId,
      `!document.querySelector('#workspace-add').hidden && [...document.querySelectorAll('#directory-list [data-directory-path]')].some((button) => button.dataset.directoryPath === ${JSON.stringify(cwd)})`,
    ),
    async () => evaluate(sessionId, "({ auth: document.querySelector('#auth-status').textContent, pickerHidden: document.querySelector('#workspace-add').hidden, path: document.querySelector('#directory-path').textContent, directories: [...document.querySelectorAll('#directory-list [data-directory-path]')].map((button) => button.dataset.directoryPath), error: document.querySelector('#workbench-error').textContent })"),
  );
  assert.equal(
    await evaluate(sessionId, "document.querySelector('#auth-status').textContent"),
    "Browser access verified.",
    "successful passkey sign-in must return to the preserved Add Project intent",
  );
  await evaluate(sessionId, "document.querySelector('#cancel-workspace-add').click()");
}

async function exerciseVisibleClaudeWorkbench(sessionId) {
  await evaluate(
    sessionId,
    `window.relayClaudeRequests = []; window.relayOriginalWorkbenchFetch = window.fetch; window.fetch = async (input, init) => { const path = new URL(typeof input === "string" ? input : input.url, window.location.href).pathname; if (path.startsWith("/node/claude/")) window.relayClaudeRequests.push({ path, method: init?.method ?? "GET" }); return window.relayOriginalWorkbenchFetch(input, init); }; document.querySelector('[data-provider="claude"]').click();`,
  );
  await waitFor(
    async () => Boolean(await evaluate(sessionId, "document.querySelector('.terminal-host .xterm-helper-textarea')")),
    async () => evaluate(sessionId, "({ error: document.querySelector('#workbench-error').textContent, code: document.querySelector('#workbench-error').dataset.code, sessions: document.querySelector('#session-list').innerText, pane: document.querySelector('#pane-root').innerText })"),
  );
  await evaluate(sessionId, "document.querySelector('.terminal-host .xterm-helper-textarea').focus()");
  await browser.command("Input.insertText", { text: "browser-ui" }, sessionId);
  await browser.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  }, sessionId);
  await browser.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  }, sessionId);
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelector('.terminal-host .xterm-rows')?.textContent"))?.includes("browser-ui"),
    async () => evaluate(sessionId, "({ status: document.querySelector('.terminal-status')?.textContent, rows: document.querySelector('.terminal-host .xterm-rows')?.textContent, requests: window.relayClaudeRequests })"),
  );
  const actions = await evaluate(sessionId, "window.relayClaudeRequests");
  assert.ok(actions.some((action) => action.path.endsWith("/resize")), "visible xterm must resize the shared PTY from its pane bounds");
  assert.ok(actions.some((action) => action.path.endsWith("/input")), "visible xterm input must use the shared PTY API");
  const beforeRefreshOutput = await evaluate(sessionId, "document.querySelector('.terminal-host .xterm-rows').textContent");
  const beforeRefreshEchoes = beforeRefreshOutput.split("browser-ui").length - 1;
  assert.ok(beforeRefreshEchoes >= 1, "visible xterm must render real fixture output before refresh");
  await evaluate(sessionId, "document.querySelector('#interrupt-session').click()");
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelector('.terminal-status')?.textContent"))?.includes("exited"),
    async () => evaluate(sessionId, "({ status: document.querySelector('.terminal-status')?.textContent, requests: window.relayClaudeRequests })"),
  );
  assert.ok(
    (await evaluate(sessionId, "window.relayClaudeRequests")).some((action) => action.path.endsWith("/interrupt")),
    "visible interrupt must target the selected Claude Session",
  );

  await browser.command("Page.reload", { ignoreCache: true }, sessionId);
  await waitFor(async () => (await evaluate(sessionId, "document.readyState")) === "complete");
  await waitFor(async () => Boolean(await evaluate(sessionId, "document.querySelector('.terminal-host .xterm-rows')?.textContent.includes('browser-ui')")));
  const restoredOutput = await evaluate(sessionId, "document.querySelector('.terminal-host .xterm-rows').textContent");
  assert.equal(
    restoredOutput.split("browser-ui").length - 1,
    beforeRefreshEchoes,
    "refresh restoration must not duplicate terminal output",
  );
  assert.match(
    await evaluate(sessionId, "document.querySelector('.terminal-status').textContent"),
    /exited/,
    "refresh must restore an honest runtime terminal status",
  );
  await evaluate(sessionId, "document.querySelector('#close-terminal').click()");
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelector('.terminal-status')?.textContent"))?.includes("closed"),
    async () => evaluate(sessionId, "({ status: document.querySelector('.terminal-status')?.textContent, error: document.querySelector('#workbench-error').textContent })"),
  );
  assert.equal(
    await evaluate(sessionId, "getComputedStyle(document.querySelector('#session-list .session-row__action[hidden]')).display"),
    "none",
    "Claude history must not expose the chat-only Resume action",
  );
}

async function exerciseLiveWorkbench(sessionId) {
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('#workspace-list button').length")) === 1);
  assert.equal(
    await evaluate(sessionId, "document.querySelector('[data-provider=\"hermes\"]').disabled"),
    true,
    "an unavailable Hermes adapter must remain visibly unavailable instead of presenting a fake conversation",
  );
  const previousSessionCount = await evaluate(sessionId, "document.querySelectorAll('#session-list .sidebar-item').length");
  await evaluate(sessionId, "document.querySelector('[data-provider=\"codex\"]').click()");
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelectorAll('#session-list .sidebar-item').length")) >= previousSessionCount + 1,
    async () => evaluate(sessionId, "({ error: document.querySelector('#workbench-error').textContent, errorCode: document.querySelector('#workbench-error').dataset.code, state: document.querySelector('#session-status').dataset.state })"),
  );
  const composerState = await evaluate(
    sessionId,
    "({ inputDisabled: document.querySelector('#message-input').disabled, sendDisabled: document.querySelector('#send-message').disabled, sendType: document.querySelector('#send-message').type, formId: document.querySelector('#send-message').form?.id })",
  );
  assert.deepEqual(composerState, { inputDisabled: false, sendDisabled: false, sendType: "submit", formId: "composer" });
  await evaluate(
    sessionId,
    `window.relaySubmitObserved = false; document.querySelector("#composer").addEventListener("submit", () => { window.relaySubmitObserved = true; }, { once: true }); document.querySelector("#message-input").value = "Reply with one word: relay"; document.querySelector("#send-message").click();`,
  );
  assert.equal(await evaluate(sessionId, "window.relaySubmitObserved"), true, "Send must submit the shared composer");
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelectorAll('.chat-event--user').length")) === 1,
    async () => ({
      dom: await evaluate(sessionId, "({ disabled: document.querySelector('#message-input').disabled, error: document.querySelector('#workbench-error').textContent, errorCode: document.querySelector('#workbench-error').dataset.code, timeline: document.querySelector('.chat-timeline')?.innerText, state: document.querySelector('#session-status').dataset.state })"),
      runtimeEvents: browser.events.filter((event) => event.method === "Runtime.exceptionThrown"),
    }),
  );
  await waitFor(
    async () => evaluate(sessionId, "[...document.querySelectorAll('.chat-event code')].some((label) => label.textContent === 'turn.started')"),
    async () => evaluate(sessionId, "({ error: document.querySelector('#workbench-error').textContent, errorCode: document.querySelector('#workbench-error').dataset.code, state: document.querySelector('#session-status').dataset.state, timeline: document.querySelector('.chat-timeline')?.innerText })"),
  );
  const previousTabCount = await evaluate(sessionId, "document.querySelectorAll('.session-tab').length");
  await evaluate(sessionId, "document.querySelector('[data-layout-action=\"new-tab\"]').click()");
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelectorAll('.session-tab').length")) === previousTabCount + 1,
    "a new presentation tab",
  );
  await evaluate(sessionId, "document.querySelector('[data-layout-action=\"split-pane\"]').click()");
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('.workbench-pane').length")) === 2);
  const divider = await evaluate(
    sessionId,
    "(() => { const box = document.querySelector('.pane-divider').getBoundingClientRect(); const split = document.querySelector('.workspace-split').getBoundingClientRect(); return { compact: window.matchMedia('(max-width: 64rem)').matches, x: box.x + box.width / 2, y: box.y + box.height / 2, width: split.width, height: split.height }; })()",
  );
  const targetX = divider.x + Math.min(80, divider.width / 5);
  const targetY = divider.y + Math.min(80, divider.height / 5);
  await evaluate(
    sessionId,
    `(() => {
      const handle = document.querySelector('.pane-divider');
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: ${divider.x}, clientY: ${divider.y}, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: ${divider.compact ? divider.x : targetX}, clientY: ${divider.compact ? targetY : divider.y}, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: ${divider.compact ? divider.x : targetX}, clientY: ${divider.compact ? targetY : divider.y}, pointerId: 1 }));
    })()`,
  );
  await waitFor(async () => Number(await evaluate(sessionId, "document.querySelector('.pane-divider').getAttribute('aria-valuenow')")) > 50, "a resized pane divider");
  await evaluate(
    sessionId,
    `(() => {
      const source = document.querySelector('[data-pane-id="pane-1"][data-tab-index="0"]');
      const target = document.querySelector('[data-pane-id="pane-2"][data-tab-index="0"]');
      const data = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
    })()`,
  );
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('[data-pane-id=\"pane-2\"].session-tab').length")) === 2, "a tab moved across panes");
  const viewport = await evaluate(
    sessionId,
    "(() => { const split = document.querySelector('.workspace-split'); return { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, shellWidth: document.querySelector('.workbench-shell').getBoundingClientRect().width, splitWidth: split.getBoundingClientRect().width, mainWidth: document.querySelector('.main-panel').getBoundingClientRect().width, paneRootWidth: document.querySelector('.pane-root').getBoundingClientRect().width, columns: getComputedStyle(split).gridTemplateColumns, inlineColumns: split.style.gridTemplateColumns, paneWidths: [...document.querySelectorAll('.workbench-pane')].map((pane) => pane.getBoundingClientRect().width), tabScrollWidths: [...document.querySelectorAll('.tab-strip')].map((tabs) => tabs.scrollWidth) }; })()",
  );
  assert.equal(viewport.scrollWidth > viewport.innerWidth, false, `split workbench overflow: ${JSON.stringify(viewport)}`);
  if (process.env.RELAY_WORKBENCH_SCREENSHOT_PATH) {
    const screenshot = await browser.command("Page.captureScreenshot", { format: "png" }, sessionId);
    await writeFile(process.env.RELAY_WORKBENCH_SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
  }
  await browser.command("Page.reload", { ignoreCache: true }, sessionId);
  await waitFor(async () => (await evaluate(sessionId, "document.readyState")) === "complete");
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('#session-list .sidebar-item').length")) >= 1);
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('.workbench-pane').length")) === 2, "a restored pane layout");
  await evaluate(sessionId, "document.querySelector('#session-list button[aria-label=\"Resume session\"]').click()");
  await waitFor(async () => (await evaluate(sessionId, "document.querySelectorAll('#session-list .sidebar-item').length")) >= 2, "a resumed Codex session");
  const restored = await evaluate(
    sessionId,
    "({ workspaceCount: document.querySelectorAll('#workspace-list button').length, userEvents: document.querySelectorAll('.chat-event--user').length, panes: document.querySelectorAll('.workbench-pane').length, sessionState: document.querySelector('#session-status').dataset.state })",
  );
  assert.equal(restored.workspaceCount, 1, "browser refresh must restore the selected CWD Workspace");
  assert.ok(restored.userEvents >= 1, "submitted user text must remain in the restored shared timeline");
  assert.equal(restored.panes, 2, "browser refresh must restore the direct-manipulation layout");
  assert.notEqual(restored.sessionState, "unknown", "restored session must report an honest provider state");
}

async function createCertificate() {
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${scratch}/key.pem`,
      "-out",
      `${scratch}/cert.pem`,
      "-days",
      "1",
      "-subj",
      "/CN=relay.test",
      "-addext",
      "subjectAltName=DNS:relay.test",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`could not create browser test certificate: ${result.stderr}`);
}

async function startProxy(hubPort) {
  const [key, cert] = await Promise.all([readFile(`${scratch}/key.pem`), readFile(`${scratch}/cert.pem`)]);
  const server = createHttpsServer({ key, cert }, (request, response) => {
    const path = new URL(request.url ?? "/", origin).pathname;
    if (path === "/health" || path.startsWith("/auth/") || path.startsWith("/api/") || path.startsWith("/node/") || path.startsWith("/protected/")) {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: hubPort,
          method: request.method,
          path: request.url,
          headers: request.headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => response.writeHead(502).end());
      request.pipe(upstream);
      return;
    }
    void serveStatic(path, response);
  });
  server.listen(httpsPort, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function serveStatic(path, response) {
  const relative = path === "/" ? "index.html" : path.slice(1);
  const [base, baseRelative] = relative === "vendor/xterm.js"
    ? [xtermRoot, "lib/xterm.js"]
    : relative === "vendor/xterm.css"
      ? [xtermRoot, "css/xterm.css"]
      : relative === "manifest.webmanifest"
        ? [publicRoot, relative]
        : [root, relative];
  const file = resolve(base, baseRelative);
  if (!file.startsWith(`${base}${sep}`) && file !== base) {
    response.writeHead(404).end();
    return;
  }
  try {
    await access(file);
    const content = await readFile(file);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType(extname(file)),
    });
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
}

function contentType(extension) {
  return new Map([
    [".html", "text/html; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".webmanifest", "application/manifest+json"],
  ]).get(extension) ?? "application/octet-stream";
}

async function reservePort() {
  const server = createHttpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve_) => server.close(resolve_));
  return port;
}

function captureProcessOutput(process_) {
  let output = "";
  for (const stream of [process_.stdout, process_.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-4_096);
    });
  }
  return () => output;
}

async function connectBrowser(process_, output, profile) {
  const debuggerUrl = await waitFor(
    async () => {
      const endpoint = (await devToolsEndpointFromProfile(profile)) ?? devToolsEndpointFromOutput(output());
      if (endpoint) return endpoint;
      if (process_.exitCode !== null || process_.signalCode !== null) {
        throw new Error(`Chromium exited before exposing a DevTools endpoint: ${processOutputSummary(process_, output())}`);
      }
      return false;
    },
    () => `Chromium DevTools endpoint: ${processOutputSummary(process_, output())}`,
    45_000,
  );
  try {
    return await Cdp.connect(debuggerUrl);
  } catch (error) {
    throw new Error(`could not connect to Chromium DevTools at ${debuggerUrl}: ${processOutputSummary(process_, output())}`, {
      cause: error,
    });
  }
}

async function devToolsEndpointFromProfile(profile) {
  try {
    return devToolsEndpointFromActivePort(await readFile(resolve(profile, "DevToolsActivePort"), "utf8"));
  } catch {
    return undefined;
  }
}

function processOutputSummary(process_, output) {
  const status =
    process_.exitCode !== null
      ? `exited with ${process_.exitCode}`
      : process_.signalCode !== null
        ? `exited from ${process_.signalCode}`
        : "running";
  const compactOutput = output.trim().replace(/\s+/g, " ").slice(0, 1_000) || "(no Chromium output)";
  return `Chromium ${status}; output: ${compactOutput}`;
}

async function evaluate(sessionId, expression) {
  const response = await browser.command(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(predicate, timeoutDescription = "browser matrix state", timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve_) => setTimeout(resolve_, 50));
  }
  const description = typeof timeoutDescription === "function" ? await timeoutDescription() : timeoutDescription;
  throw new Error(`timed out waiting for ${typeof description === "string" ? description : JSON.stringify(description)}`);
}
