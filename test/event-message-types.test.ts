import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

test('EventMessage types compile without errors', () => {
  try {
    execFileSync('npx', ['tsc', '--noEmit', '--strict', '-p', 'tsconfig.json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    assert.ok(true, 'TypeScript compilation succeeded');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    assert.fail(`TypeScript compilation failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  }
});
