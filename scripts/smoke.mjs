import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";

const bindAddress = "127.0.0.1:0";
const longIdentity = "x".repeat(33);
let address;
let port;

function runCargo(arguments_) {
  return spawnSync("cargo", arguments_, { encoding: "utf8" });
}

function assertExit(result, code, context) {
  assert.equal(result.status, code, `${context}: ${result.stderr}`);
}

const nodeProbe = runCargo(["run", "--quiet", "-p", "relay-node", "--", "probe", "--identity", "node"]);
assertExit(nodeProbe, 0, "node probe");
assert.deepEqual(JSON.parse(nodeProbe.stdout), {
  api: "relay-factory/v1",
  service: "node",
  status: "ok",
  version: "0.1.0",
});

const rejected = runCargo([
  "run",
  "--quiet",
  "-p",
  "relay-node",
  "--",
  "probe",
  "--identity",
  longIdentity,
]);
assertExit(rejected, 2, "overlong node identity");
assert.deepEqual(JSON.parse(rejected.stderr), {
  error: { code: "input_too_long", limit: 32 },
});
assert.doesNotMatch(rejected.stderr, new RegExp(longIdentity));

const hub = spawn(
  "cargo",
  ["run", "--quiet", "-p", "relay-hub", "--", "serve", "--bind", bindAddress, "--identity", "hub"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const hubExited = once(hub, "exit");
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
  await waitForLiveness(output, hub);
  await assertHealthResponse();
  await assertSurvivesDisconnectedClient();
  await assertHealthResponse();
  await assertSurvivesStalledClient();
  await assertHealthResponse();
  await assertNotFoundResponse("POST /health HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await assertHealthResponse();
  await assertNotFoundResponse(`GET /${"x".repeat(1_024)} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  await assertHealthResponse();
  await assertWaitsForHeaderTerminator();
  await assertHealthResponse();
  const splitResponse = await requestChunks([
    "GET /hea",
    "lth HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
  ]);
  assert.match(splitResponse, /^HTTP\/1\.1 200 OK\r\n/);
  await assertHealthResponse();
  console.log("factory liveness smoke passed");
} finally {
  if (hub.exitCode === null) {
    hub.kill("SIGTERM");
  }
  await hubExited;
}

async function waitForLiveness(currentOutput, process_) {
  const deadline = Date.now() + 10_000;
  let output_ = currentOutput;
  while (!output_.includes("relay-hub liveness listening")) {
    if (Date.now() > deadline) {
      throw new Error(`hub did not start: ${output_}`);
    }
    await delay(50);
    output_ = output;
    if (process_.exitCode !== null) {
      throw new Error(`hub exited before liveness: ${output_}`);
    }
  }

  const boundAddress = output_.match(/relay-hub liveness listening on (127\.0\.0\.1:\d+)/)?.[1];
  if (!boundAddress) {
    throw new Error(`hub reported an unsupported listener address: ${output_}`);
  }
  address = boundAddress;
  port = Number(boundAddress.slice(boundAddress.lastIndexOf(":") + 1));
}

async function assertHealthResponse() {
  const response = await fetch(`http://${address}/health`, { signal: AbortSignal.timeout(2_000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    api: "relay-factory/v1",
    service: "hub",
    status: "ok",
    version: "0.1.0",
  });
}

async function assertSurvivesDisconnectedClient() {
  const client = createConnection({ host: "127.0.0.1", port });
  client.on("error", () => {});
  await once(client, "connect");
  client.destroy();
}

async function assertSurvivesStalledClient() {
  const client = createConnection({ host: "127.0.0.1", port });
  client.on("error", () => {});
  await once(client, "connect");
  await delay(2_200);
  client.destroy();
}

async function assertNotFoundResponse(request) {
  const response = await requestChunks([request]);
  assert.match(response, /^HTTP\/1\.1 404 Not Found\r\n/);
}

async function assertWaitsForHeaderTerminator() {
  const socket = createConnection({ host: "127.0.0.1", port });
  let response = "";
  socket.setEncoding("utf8");

  const closed = new Promise((resolve) => {
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", () => {});
    socket.once("close", resolve);
  });

  await once(socket, "connect");
  socket.write("GET /health HTTP/1.1\r\nHost: local");
  await delay(100);
  assert.equal(response, "", "hub must wait for the complete HTTP header before responding");
  socket.end("host\r\nConnection: close\r\n\r\n");
  await closed;
  assert.match(response, /^HTTP\/1\.1 200 OK\r\n/);
}

async function requestChunks(chunks) {
  const socket = createConnection({ host: "127.0.0.1", port });
  let response = "";
  socket.setEncoding("utf8");

  const closed = new Promise((resolve) => {
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", () => {});
    socket.once("close", resolve);
  });

  await once(socket, "connect");
  for (const [index, chunk] of chunks.entries()) {
    socket.write(chunk);
    if (index < chunks.length - 1) {
      await delay(50);
    }
  }
  socket.end();
  await closed;
  return response;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
