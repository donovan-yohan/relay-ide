import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

test('project root from dist/ contains frontend/ directory', () => {
  const frontendDir = path.join(projectRoot, 'frontend');
  expect(fs.existsSync(frontendDir)).toBeTruthy();
});

test('project root from dist/ contains frontend/index.html', () => {
  const indexHtml = path.join(projectRoot, 'frontend', 'index.html');
  expect(fs.existsSync(indexHtml)).toBeTruthy();
});

test('dist/server/ exists after compilation', () => {
  const serverDir = path.join(projectRoot, 'dist', 'server');
  expect(fs.existsSync(serverDir)).toBeTruthy();
});

test('server index.ts uses correct path depth to reach dist/frontend/', async () => {
  // Read the source file and verify the path pattern
  const indexSource = fs.readFileSync(
    path.join(projectRoot, 'server', 'index.ts'),
    'utf8'
  );

  // Static serving must go up one level from dist/server/ to dist/, then into frontend/
  expect(
    indexSource.includes("path.join(__dirname, '..', 'frontend')")
  ).toBeTruthy();

  // Config fallback must also go up two levels
  expect(
    indexSource.includes("path.join(__dirname, '..', '..', 'config.json')")
  ).toBeTruthy();
});
