/* eslint-disable no-console -- temporary CI debug, remove after fixing */
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('debug: check frontend files exist', () => {
  const frontendLib = path.resolve(__dirname, '../frontend/src/lib');
  console.error(`[DEBUG] __dirname=${__dirname}`);
  console.error(`[DEBUG] cwd=${process.cwd()}`);
  console.error(`[DEBUG] frontendLib=${frontendLib}`);
  console.error(`[DEBUG] frontendLib exists=${fs.existsSync(frontendLib)}`);

  const targetFile = path.join(frontendLib, 'session-intent.js');
  console.error(
    `[DEBUG] session-intent.js exists=${fs.existsSync(targetFile)}`
  );

  if (fs.existsSync(frontendLib)) {
    const files = fs.readdirSync(frontendLib);
    console.error(`[DEBUG] frontend/src/lib/ contents: ${files.join(', ')}`);
  } else {
    // Check what's in the parent dirs
    const frontendDir = path.resolve(__dirname, '../frontend');
    console.error(`[DEBUG] frontend/ exists=${fs.existsSync(frontendDir)}`);
    const distDir = path.resolve(__dirname, '..');
    console.error(
      `[DEBUG] parent dir (${distDir}) contents: ${fs.readdirSync(distDir).join(', ')}`
    );
  }
});
