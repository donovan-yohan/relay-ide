import { spawnSync } from "node:child_process";

const requiredNode = [22, 22, 3];
const expectedRust = "rustc 1.88.0";

function fail(message) {
  console.error(`toolchain check failed: ${message}`);
  process.exitCode = 1;
}

const actualNode = process.versions.node.split(".").map(Number);
if (actualNode.length !== 3 || actualNode.some((part) => Number.isNaN(part))) {
  fail(`unparseable Node version ${process.versions.node}`);
} else if (actualNode[0] !== requiredNode[0] || actualNode[1] < requiredNode[1]) {
  fail(`expected Node >= ${requiredNode.join(".")} < 23, got ${process.versions.node}`);
}

const rust = spawnSync("rustc", ["--version"], { encoding: "utf8" });
if (rust.status !== 0 || !rust.stdout.startsWith(expectedRust)) {
  fail(`expected ${expectedRust}; install the pinned toolchain from rust-toolchain.toml`);
}

if (process.exitCode !== 1) {
  console.log(`toolchains ok: node ${process.versions.node}; ${rust.stdout.trim()}`);
}
