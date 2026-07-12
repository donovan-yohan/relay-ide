import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";

import { devToolsEndpointFromOutput } from "./cdp-endpoint.mjs";


const chromium = "/usr/bin/chromium";
const recoveryCode = "browser-virtual-authenticator-recovery";
const root = resolve("web/src");
const publicRoot = resolve("web/public");
const scratch = await mkdtemp(`${tmpdir()}/relay-passkey-browser-`);
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
      `--user-data-dir=${scratch}/chrome-profile`,
      "--ignore-certificate-errors",
      "--host-resolver-rules=MAP relay.test 127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  browser = await connectBrowser(chromiumProcess, captureProcessOutput(chromiumProcess));
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
    if (path.startsWith("/auth/") || path.startsWith("/protected/")) {
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

async function connectBrowser(process_, output) {
  const debuggerUrl = await waitFor(
    () => {
      const endpoint = devToolsEndpointFromOutput(output());
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
