import { cp, mkdir, rm } from "node:fs/promises";

const source = "web/src";
const publicAssets = "web/public";
const output = "web/dist";

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
await Promise.all([
  cp(source, output, { recursive: true }),
  cp(publicAssets, output, { recursive: true }),
]);

console.log(`built PWA shell in ${output}`);
