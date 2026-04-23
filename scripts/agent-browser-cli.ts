#!/usr/bin/env node
/* eslint-disable no-console */
import {
  launchBrowser,
  screenshot,
  validatePage,
  closeBrowser,
} from '../server/agent-browser.js';

const command = process.argv[2];

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function getUrl(defaultUrl?: string): string {
  // The URL is either the first positional arg after command, or the default
  const candidates = process.argv.slice(3).filter((a) => !a.startsWith('--'));
  return candidates[0] ?? defaultUrl ?? process.env.RELAY_IDE_URL ?? 'http://127.0.0.1:3456';
}

function printUsage(): void {
  console.log('Usage: agent-browser-cli <command> [url] [options]');
  console.log('');
  console.log('Commands:');
  console.log('  open [url]              Launch Chrome and keep open until Ctrl+C');
  console.log('  screenshot [url] --out <path>  Take a full-page screenshot');
  console.log('  validate [url]          Load page and report console errors as JSON');
  console.log('');
  console.log('Environment:');
  console.log('  RELAY_IDE_URL           Default URL if none provided');
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

(async () => {
  if (command === 'open') {
    const url = getUrl();
    console.log(`Opening ${url} ...`);
    const session = await launchBrowser(url);
    console.log('Browser is open. Press Ctrl+C to close.');

    const teardown = async (): Promise<void> => {
      process.removeListener('SIGINT', teardown);
      process.removeListener('SIGTERM', teardown);
      try {
        await closeBrowser(session);
        console.log('Browser closed.');
      } catch (err) {
        console.error('Error closing browser:', err);
      }
      process.exit(0);
    };

    process.on('SIGINT', teardown);
    process.on('SIGTERM', teardown);

    // Keep process alive
    await new Promise(() => {});
    return;
  }

  if (command === 'screenshot') {
    const outPath = getArg('--out');
    if (!outPath) {
      console.error('Error: --out <path> is required for screenshot');
      process.exit(1);
    }
    const url = getUrl();
    console.log(`Opening ${url} ...`);
    const session = await launchBrowser(url);
    try {
      await screenshot(session, outPath);
      console.log(`Screenshot saved to ${outPath}`);
    } finally {
      await closeBrowser(session);
    }
    return;
  }

  if (command === 'validate') {
    const url = getUrl();
    console.log(`Opening ${url} ...`);
    const session = await launchBrowser(url);
    try {
      const result = await validatePage(session);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await closeBrowser(session);
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
})().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
