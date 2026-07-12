import { cp, mkdir, rm } from "node:fs/promises";

const source = "web/src";
const publicAssets = "web/public";
const output = "web/dist";

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
await mkdir(`${output}/vendor`, { recursive: true });
await Promise.all([
  cp(source, output, { recursive: true }),
  cp(publicAssets, output, { recursive: true }),
  cp("node_modules/@xterm/xterm/lib/xterm.js", `${output}/vendor/xterm.js`),
  cp("node_modules/@xterm/xterm/css/xterm.css", `${output}/vendor/xterm.css`),
]);

console.log(`built PWA shell in ${output}`);
