import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// At runtime, __dirname resolves to dist/test/.
// The server runs from dist/server/, which uses path.join(__dirname, '..', '..', ...)
// to reach the project root. This test verifies that relationship is correct.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This test file is at dist/test/, server is at dist/server/ — same depth
const projectRoot = path.resolve(__dirname, '..', '..');

test('project root from dist/ contains frontend/ directory', () => {
  const frontendDir = path.join(projectRoot, 'frontend');
  assert.ok(fs.existsSync(frontendDir), `Expected frontend/ at ${frontendDir}`);
});

test('project root from dist/ contains frontend/index.html', () => {
  const indexHtml = path.join(projectRoot, 'frontend', 'index.html');
  assert.ok(
    fs.existsSync(indexHtml),
    `Expected frontend/index.html at ${indexHtml}`
  );
});

test('dist/server/ exists after compilation', () => {
  const serverDir = path.join(projectRoot, 'dist', 'server');
  assert.ok(fs.existsSync(serverDir), `Expected dist/server/ at ${serverDir}`);
});

test('server index.ts uses correct path depth to reach dist/frontend/', async () => {
  // Read the source file and verify the path pattern
  const indexSource = fs.readFileSync(
    path.join(projectRoot, 'server', 'index.ts'),
    'utf8'
  );

  // Static serving must go up one level from dist/server/ to dist/, then into frontend/
  assert.ok(
    indexSource.includes("path.join(__dirname, '..', 'frontend')"),
    'express.static must resolve dist/frontend/ one level up from dist/server/'
  );

  // Config fallback must also go up two levels
  assert.ok(
    indexSource.includes("path.join(__dirname, '..', '..', 'config.json')"),
    'CONFIG_PATH must resolve config.json two levels up from dist/server/'
  );
});
