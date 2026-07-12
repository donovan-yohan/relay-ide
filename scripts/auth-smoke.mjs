import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";

const recoveryCode = "test-recovery-code";
const recoveryHash = createHash("sha256").update(recoveryCode).digest("hex");
const origin = "https://relay.example.test";
const hub = spawn(
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
const exited = once(hub, "exit");
let output = "";
hub.stdout.setEncoding("utf8");
hub.stdout.on("data", (chunk) => {
  output += chunk;
});
hub.stderr.setEncoding("utf8");
hub.stderr.on("data", (chunk) => {
  output += chunk;
});

try {
  const address = await waitForListener();

  await assertError(address, "GET /protected/hub HTTP/1.1\r\nHost: relay.example.test\r\n\r\n", 401, "session_missing");
  await assertError(
    address,
    post("/auth/passkeys/enroll/options", { "x-relay-recovery-code": recoveryCode }),
    403,
    "origin_mismatch",
  );
  await assertError(
    address,
    post("/auth/passkeys/enroll/options", {
      origin: "https://wrong.example.test",
      "x-relay-recovery-code": recoveryCode,
    }),
    403,
    "origin_mismatch",
  );
  await assertError(
    address,
    post("/auth/passkeys/enroll/options", {
      origin,
      "x-relay-recovery-code": "wrong-recovery-code",
    }),
    403,
    "recovery_denied",
  );

  const enrollment = await request(
    address,
    post("/auth/passkeys/enroll/options", {
      origin,
      "x-relay-recovery-code": recoveryCode,
    }),
  );
  assert.equal(enrollment.status, 200);
  assert.ok(enrollment.headers["set-cookie"]?.includes("__Host-relay_ceremony="));
  assert.ok(enrollment.headers["set-cookie"]?.includes("HttpOnly"));
  assert.ok(enrollment.headers["set-cookie"]?.includes("Secure"));
  assert.ok(enrollment.headers["set-cookie"]?.includes("SameSite=Strict"));
  assert.ok(enrollment.body.includes("publicKey"));
  assert.doesNotMatch(enrollment.body, new RegExp(recoveryCode));

  const ceremonyCookie = enrollment.headers["set-cookie"].split(";", 1)[0];
  await assertError(
    address,
    post("/auth/passkeys/enroll/verify", { cookie: ceremonyCookie, origin }, "{}"),
    403,
    "passkey_denied",
  );
  await assertError(
    address,
    post("/auth/passkeys/enroll/verify", { cookie: ceremonyCookie, origin }, "{}"),
    403,
    "unknown_ceremony",
  );
  const concurrentEnrollment = await request(
    address,
    post("/auth/passkeys/enroll/options", {
      origin,
      "x-relay-recovery-code": recoveryCode,
    }),
  );
  const concurrentCookie = concurrentEnrollment.headers["set-cookie"].split(";", 1)[0];
  const concurrentResponses = await Promise.all(
    ["first", "second"].map(() =>
      request(address, post("/auth/passkeys/enroll/verify", { cookie: concurrentCookie, origin }, "{}")),
    ),
  );
  assert.deepEqual(
    concurrentResponses.map((response) => JSON.parse(response.body).error.code).sort(),
    ["passkey_denied", "unknown_ceremony"],
    "one raced verifier consumes the ceremony and the other must fail closed",
  );
  await assertError(
    address,
    "GET /protected/node HTTP/1.1\r\nHost: relay.example.test\r\nCookie: __Host-relay_session=not-a-node-credential\r\n\r\n",
    403,
    "node_authority_required",
  );
  assert.match(
    output,
    /^relay-hub liveness listening on 127\.0\.0\.1:\d+\n$/,
    "the exercised recovery, ceremony, and denied-node path must not append secret-bearing auth data to hub logs",
  );

  console.log("passkey boundary HTTP smoke passed");
} finally {
  if (hub.exitCode === null) {
    hub.kill("SIGTERM");
  }
  await exited;
}

async function waitForListener() {
  const deadline = Date.now() + 10_000;
  while (!output.includes("relay-hub liveness listening")) {
    if (hub.exitCode !== null || Date.now() > deadline) {
      throw new Error(`hub did not start: ${output}`);
    }
    await delay(25);
  }
  const address = output.match(/relay-hub liveness listening on (127\.0\.0\.1:\d+)/)?.[1];
  if (!address) {
    throw new Error(`hub reported an unsupported listener address: ${output}`);
  }
  return address;
}

function post(path, headers = {}, body = "") {
  const fields = [
    `POST ${path} HTTP/1.1`,
    "Host: relay.example.test",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    fields.push(`${name}: ${value}`);
  }
  return `${fields.join("\r\n")}\r\n\r\n${body}`;
}

async function assertError(address, request_, status, code) {
  const response = await request(address, request_);
  assert.equal(response.status, status, response.raw);
  assert.deepEqual(JSON.parse(response.body), { error: { code } });
}

async function request(address, request_) {
  const [host, port] = address.split(":");
  const socket = createConnection({ host, port: Number(port) });
  let raw = "";
  socket.setEncoding("utf8");
  const closed = new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.once("error", reject);
    socket.once("close", resolve);
  });
  await once(socket, "connect");
  socket.end(request_);
  await closed;

  const [head, body = ""] = raw.split("\r\n\r\n", 2);
  const [statusLine, ...headers] = head.split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const parsedHeaders = Object.fromEntries(
    headers.map((line) => {
      const [name, ...value] = line.split(":");
      return [name.toLowerCase(), value.join(":").trim()];
    }),
  );
  return { body, headers: parsedHeaders, raw, status };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
