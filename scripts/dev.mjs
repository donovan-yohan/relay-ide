import { spawn, spawnSync } from "node:child_process";

const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const children = [
  spawn("cargo", ["run", "--quiet", "-p", "relay-hub", "--", "serve", "--bind", "127.0.0.1:8787"], {
    stdio: "inherit",
  }),
  spawn(process.execPath, ["scripts/serve-web.mjs"], { stdio: "inherit" }),
];

function stop(exitCode) {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(0));
}

for (const child of children) {
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      stop(code);
    }
  });
}
