#!/usr/bin/env node
/* eslint-disable no-console */
import { startSandbox } from '../server/sandbox.js';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

const portArg = getArg('--port');
const workspaceArg = getArg('--workspace');

const port = portArg ? parseInt(portArg, 10) : undefined;
if (
  portArg !== undefined &&
  (Number.isNaN(port) || port === undefined || port <= 0 || port > 65535)
) {
  console.error('Invalid port:', portArg);
  process.exit(1);
}

let pendingShutdown: NodeJS.Signals | null = null;
const onSigint = (): void => {
  pendingShutdown = 'SIGINT';
};
const onSigterm = (): void => {
  pendingShutdown = 'SIGTERM';
};
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

(async () => {
  const sandbox = await startSandbox({
    port,
    workspacePath: workspaceArg,
  });

  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);

  if (pendingShutdown) {
    await sandbox.teardown();
    process.exit(pendingShutdown === 'SIGINT' ? 130 : 143);
  }

  console.log(`Sandbox ready at ${sandbox.url}`);

  const teardown = async (): Promise<void> => {
    process.removeListener('SIGINT', teardown);
    process.removeListener('SIGTERM', teardown);
    try {
      await sandbox.teardown();
      console.log('Sandbox teardown complete.');
    } catch (err) {
      console.error('Teardown error:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);

  sandbox.process.on('exit', (code) => {
    console.log(`Sandbox server exited with code ${code ?? 'unknown'}.`);
    process.exit(code ?? 0);
  });

  // Keep process alive
  await new Promise(() => {});
})().catch((err) => {
  console.error('Sandbox failed:', err);
  process.exit(1);
});
