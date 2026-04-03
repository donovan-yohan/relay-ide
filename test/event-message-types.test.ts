import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

function findTsc(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsc');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'tsc'; // fallback to PATH
}

test('EventMessage types compile without errors', () => {
  const tscPath = findTsc(process.cwd());
  try {
    execFileSync(tscPath, ['--noEmit', '--strict', '-p', 'tsconfig.json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    expect(true).toBeTruthy();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `TypeScript compilation failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`
    );
  }
});
