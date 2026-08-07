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

  // #961: the from-source config fallback must NOT default into the repo root.
  // It now resolves to a per-checkout app-data dir via resolveSourceLaunchConfigPath.
  expect(
    indexSource.includes("path.join(__dirname, '..', '..', 'config.json')")
  ).toBe(false);
  expect(indexSource.includes('resolveSourceLaunchConfigPath')).toBe(true);
});

test('no package.json script pins RELAY_IDE_CONFIG to a repo-relative path (#961)', () => {
  // A repo-relative RELAY_IDE_CONFIG (e.g. ./config.dev.json) anchors the config
  // dir — and every SQLite store beside it — to npm's cwd = the checkout root,
  // spilling runtime state into the repo. Scripts must either omit the var (use
  // the app-data default) or compute an absolute path.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  ) as { scripts: Record<string, string> };

  const offenders = Object.entries(pkg.scripts).filter(([, cmd]) =>
    /RELAY_IDE_CONFIG=(\.|[^"'\s]*\$\{?PWD)/.test(cmd)
  );

  expect(offenders).toEqual([]);
});
