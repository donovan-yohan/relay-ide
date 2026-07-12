import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { access, mkdtemp, readFile } from "node:fs/promises";
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
const vendorFiles = new Map([
  ["/vendor/xterm.js", resolve("node_modules/@xterm/xterm/lib/xterm.js")],
  ["/vendor/xterm.css", resolve("node_modules/@xterm/xterm/css/xterm.css")],
]);
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
    socket.addEventListener("message", (message) => {
      const response = JSON.parse(message.data);
      const pending = this.pending.get(response.id);
      if (!pending) return;
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
  const { targetId } = await browser.command("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.command("Target.attachToTarget", { targetId, flatten: true });
  await browser.command("Page.enable", {}, sessionId);
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
  await evaluate(
    sessionId,
    "window.relayPageErrors = []; addEventListener('error', (event) => window.relayPageErrors.push(event.message)); addEventListener('unhandledrejection', (event) => window.relayPageErrors.push(String(event.reason)));",
  );

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
  await waitFor(async () => (await evaluate(sessionId, "document.querySelector('#auth-status').textContent"))?.includes("Passkey verified"));
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelector('#open-claude').disabled")) === false,
    "authenticated Claude terminal affordance",
  );
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

  await evaluate(
    sessionId,
    `window.relayOriginalTerminalCreateFetch = window.fetch; window.relayTerminalCreateRequests = 0; window.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input.url, window.location.href); const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method); if (method === 'POST' && url.pathname === '/node/claude/sessions') { window.relayTerminalCreateRequests += 1; await new Promise((resolve) => setTimeout(resolve, 25)); } return window.relayOriginalTerminalCreateFetch(input, init); }; const open = document.querySelector('#open-claude'); open.click(); open.click();`,
  );
  await waitFor(async () => {
    const status = await evaluate(sessionId, "document.querySelector('.terminal-status')?.textContent");
    return status?.includes("Relay-owned terminal · running");
  }, "Relay-owned Claude terminal render");
  assert.equal(
    await evaluate(sessionId, "window.relayTerminalCreateRequests"),
    1,
    "double-clicked terminal creation must serialize to one Relay-owned PTY",
  );
  assert.equal(
    await evaluate(sessionId, "document.querySelector('#open-claude').disabled"),
    true,
    "a live terminal cannot overwrite its only opaque Session reference",
  );
  await evaluate(sessionId, "window.fetch = window.relayOriginalTerminalCreateFetch; delete window.relayOriginalTerminalCreateFetch; delete window.relayTerminalCreateRequests");
  const terminal = await evaluate(
    sessionId,
    `(() => {
      const sessionId = document.querySelector('.session-card code')?.textContent;
      const csrf = document.cookie.split('; ').find((cookie) => cookie.startsWith('__Host-relay_csrf='))?.slice('__Host-relay_csrf='.length);
      return { hasTerminal: Boolean(document.querySelector('.terminal-host .xterm')), sessionId, csrf };
    })()`,
  );
  assert.equal(terminal.hasTerminal, true, "the workbench must render an interactive xterm surface");
  assert.match(terminal.sessionId, /^claude-pty-\d+$/, "the browser receives only an opaque Relay Session ID");
  assert.ok(terminal.csrf, "the browser keeps a CSRF token distinct from the HttpOnly session cookie");
  await evaluate(
    sessionId,
    `window.relayOriginalTerminalFetch = window.fetch; window.relayTerminalPollFailed = false; window.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input.url, window.location.href); const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method); if (!window.relayTerminalPollFailed && method === 'GET' && url.pathname.startsWith('/node/claude/sessions/')) { window.relayTerminalPollFailed = true; throw new TypeError('transient terminal poll failure'); } return window.relayOriginalTerminalFetch(input, init); };`,
  );
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelector('.terminal-status')?.textContent"))?.startsWith("Terminal unavailable:"),
    "transient terminal polling failure",
  );
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelector('.terminal-status')?.textContent"))?.includes("Relay-owned terminal · running"),
    "terminal polling recovery",
  );
  await evaluate(sessionId, "window.fetch = window.relayOriginalTerminalFetch; delete window.relayOriginalTerminalFetch; delete window.relayTerminalPollFailed");
  await evaluate(
    sessionId,
    `window.relayOriginalTerminalInputFetch = window.fetch; window.relayTerminalInputFailed = false; window.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input.url, window.location.href); const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method); if (!window.relayTerminalInputFailed && method === 'POST' && url.pathname.endsWith('/input')) { window.relayTerminalInputFailed = true; throw new TypeError('uncertain terminal input delivery'); } return window.relayOriginalTerminalInputFetch(input, init); };`,
  );
  await evaluate(sessionId, "document.querySelector('.xterm-helper-textarea').focus()");
  await browser.command("Input.insertText", { text: "saved-across-layout-render\n" }, sessionId);
  await waitFor(
    async () => await evaluate(sessionId, `(() => {
      const recovery = document.querySelector('.terminal-input-recovery');
      return recovery && !recovery.hidden && recovery.textContent.includes('input is saved');
    })()`),
    "saved uncertain terminal input",
  );
  await evaluate(sessionId, "window.fetch = window.relayOriginalTerminalInputFetch; delete window.relayOriginalTerminalInputFetch; delete window.relayTerminalInputFailed");
  const recoveryAfterLayout = await evaluate(
    sessionId,
    `(() => {
      document.querySelector('[data-action="split"]').click();
      const recovery = document.querySelector('.pane[data-selected="true"] .terminal-input-recovery');
      return {
        visible: Boolean(recovery && !recovery.hidden),
        message: recovery?.textContent,
        controls: [...recovery?.querySelectorAll('button') ?? []].map((button) => button.textContent),
      };
    })()`,
  );
  assert.equal(recoveryAfterLayout.visible, true, "a layout render must preserve paused uncertain terminal input");
  assert.match(recoveryAfterLayout.message, /input is saved/i);
  assert.deepEqual(recoveryAfterLayout.controls, ["Retry saved input", "Discard saved input"]);
  const retryStatus = await evaluate(
    sessionId,
    `(() => {
      document.querySelector('.pane[data-selected="true"] .terminal-input-recovery button').click();
      return document.querySelector('.pane[data-selected="true"] .terminal-status')?.textContent;
    })()`,
  );
  assert.match(retryStatus, /Retrying saved terminal input/);
  await waitFor(
    async () => await evaluate(sessionId, "document.querySelector('.pane[data-selected=\"true\"] .terminal-input-recovery')?.hidden === true"),
    "saved terminal input retry after a layout render",
  );
  await evaluate(
    sessionId,
    `window.relayOriginalInFlightInputFetch = window.fetch; window.relayInFlightInputStarted = false; window.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input.url, window.location.href); const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method); if (!window.relayInFlightInputStarted && method === 'POST' && url.pathname.endsWith('/input')) { window.relayInFlightInputStarted = true; await new Promise(() => {}); } return window.relayOriginalInFlightInputFetch(input, init); };`,
  );
  await evaluate(sessionId, "document.querySelector('.xterm-helper-textarea').focus()");
  await browser.command("Input.insertText", { text: "in-flight-across-layout-render\\n" }, sessionId);
  await waitFor(
    async () => await evaluate(sessionId, "window.relayInFlightInputStarted"),
    "in-flight terminal input request",
  );
  const inFlightRecoveryAfterLayout = await evaluate(
    sessionId,
    `(() => {
      document.querySelector('[data-action="split"]').click();
      const recovery = document.querySelector('.pane[data-selected="true"] .terminal-input-recovery');
      return {
        visible: Boolean(recovery && !recovery.hidden),
        message: recovery?.textContent,
        controls: [...recovery?.querySelectorAll('button') ?? []].map((button) => button.textContent),
      };
    })()`,
  );
  assert.equal(inFlightRecoveryAfterLayout.visible, true, "a layout render must preserve in-flight terminal input for an explicit operator decision");
  assert.match(inFlightRecoveryAfterLayout.message, /delivery was in progress/i);
  assert.deepEqual(inFlightRecoveryAfterLayout.controls, ["Retry saved input", "Discard saved input"]);
  await evaluate(sessionId, "document.querySelector('.pane[data-selected=\"true\"] .terminal-input-recovery button:nth-of-type(2)').click(); window.fetch = window.relayOriginalInFlightInputFetch; delete window.relayOriginalInFlightInputFetch; delete window.relayInFlightInputStarted");
  await evaluate(sessionId, "document.querySelector('.xterm-helper-textarea').focus()");
  await browser.command("Input.insertText", { text: "browser-keyboard\n" }, sessionId);
  const terminalOperations = await evaluate(
    sessionId,
    `(async () => {
      const sessionId = document.querySelector('.session-card code').textContent;
      const csrf = document.cookie.split('; ').find((cookie) => cookie.startsWith('__Host-relay_csrf='))?.slice('__Host-relay_csrf='.length);
      const post = (suffix, body) => fetch('/node/claude/sessions/' + sessionId + suffix, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Relay-CSRF': csrf }, body: JSON.stringify(body),
      }).then((response) => response.status);
      const resize = await post('/resize', { cols: 92, rows: 28 });
      let poll = { output: [] };
      for (let attempt = 0; attempt < 25; attempt += 1) {
        poll = await fetch('/node/claude/sessions/' + sessionId + '?trace=browser-smoke&cursor=0', { credentials: 'same-origin' }).then((response) => response.json());
        if (poll.output.some((chunk) => chunk.text.includes('browser-keyboard'))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const mirrored = [...document.querySelectorAll('.session-card code')].map((node) => node.textContent);
      return { resize, poll, mirrored };
    })()`,
  );
  assert.equal(terminalOperations.resize, 200, "the visible terminal must resize through the authenticated node boundary");
  assert.ok(
    terminalOperations.poll.output.some((chunk) => chunk.text.includes("browser-keyboard")),
    "keyboard input through xterm must reach the Relay-owned PTY and return as terminal output",
  );
  assert.ok(
    terminalOperations.mirrored.length >= 2
      && terminalOperations.mirrored.every((sessionId) => sessionId === terminal.sessionId),
    "split panes must retain one Session identity while the browser detaches and reattaches its terminal view",
  );
  await evaluate(sessionId, "document.querySelector('#interrupt-session').click()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const interruptStatus = await evaluate(sessionId, "document.querySelector('.terminal-status')?.textContent");
  assert.doesNotMatch(
    interruptStatus,
    /rejected|unavailable/i,
    "browser interrupt must be accepted without turning Ctrl-C into implicit terminal close",
  );
  await evaluate(sessionId, "document.querySelector('#end-session').click()");
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelector('[data-layout-notice]')?.textContent"))?.includes("closed and reaped"),
    "explicit Relay close state",
  );
  assert.equal(
    await evaluate(sessionId, "document.querySelector('#open-claude').disabled"),
    false,
    "explicit close must permit replacing the terminal Session reference",
  );
  await evaluate(sessionId, "document.querySelector('#open-claude').click()");
  await waitFor(
    async () => (await evaluate(sessionId, "document.querySelector('.pane[data-selected=\"true\"] .terminal-status')?.textContent"))?.includes("Relay-owned terminal · running"),
    "replacement terminal before browser-session revocation",
  );
  assert.deepEqual(await evaluate(sessionId, "window.relayPageErrors"), [], "the terminal flow must not raise page errors");

  const revokeStatuses = await evaluate(
    sessionId,
    `Promise.all(["first", "second"].map(async () => {
      const sessions = await fetch("/auth/sessions", { credentials: "same-origin" }).then((response) => response.json());
      const deviceId = sessions.sessions.find((session) => session.current).deviceId;
      const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("__Host-relay_csrf=")).slice("__Host-relay_csrf=".length);
      return fetch("/auth/sessions/revoke", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Relay-CSRF": csrf },
        body: JSON.stringify({ deviceId }),
      }).then((response) => response.status);
    }))`,
  );
  assert.deepEqual(
    revokeStatuses.sort(),
    [200, 401],
    "exactly one concurrent revoke must consume the session",
  );
  assert.equal(
    await evaluate(sessionId, "fetch('/protected/hub', { credentials: 'same-origin' }).then((response) => response.status)"),
    401,
    "a concurrently revoked browser session must fail closed",
  );
  assert.equal(
    await evaluate(sessionId, "fetch('/protected/node', { credentials: 'same-origin' }).then((response) => response.status)"),
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
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
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

async function recoveryValueAfterFailedEnrollment(sessionId) {
  await evaluate(
    sessionId,
    `document.querySelector("#auth-status").textContent = ""; document.querySelector("#recovery-code").value = ${JSON.stringify(recoveryCode)}; document.querySelector("#enroll-passkey").click();`,
  );
  await waitFor(async () => Boolean(await evaluate(sessionId, "document.querySelector('#auth-status').textContent")));
  return evaluate(sessionId, "document.querySelector('#recovery-code').value");
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
    if (path === "/health" || path.startsWith("/auth/") || path.startsWith("/node/") || path.startsWith("/protected/")) {
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
  const vendor = vendorFiles.get(path);
  if (vendor) {
    try {
      const content = await readFile(vendor);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentType(extname(vendor)),
      });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  const relative = path === "/" ? "index.html" : path.slice(1);
  const base = relative === "manifest.webmanifest" ? publicRoot : root;
  const file = resolve(base, relative);
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

async function waitFor(predicate, timeoutDescription = "browser matrix state") {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve_) => setTimeout(resolve_, 50));
  }
  throw new Error(`timed out waiting for ${typeof timeoutDescription === "function" ? timeoutDescription() : timeoutDescription}`);
}
