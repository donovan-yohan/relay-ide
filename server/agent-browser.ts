import fs from 'node:fs';
import type { Browser, Page } from 'playwright';

let chromium: typeof import('playwright').chromium | undefined;

try {
  const pw = await import('playwright');
  chromium = pw.chromium;
} catch {
  // playwright not installed — functions will throw helpful errors
}

const MISSING_BINARY_MESSAGE =
  'Playwright is unavailable. Install this project\'s dependencies, then run `npx playwright install` to install browser binaries if needed.';

function ensurePlaywright(): void {
  if (!chromium) {
    throw new Error(MISSING_BINARY_MESSAGE);
  }
  try {
    const execPath = chromium.executablePath();
    if (!fs.existsSync(execPath)) {
      throw new Error(MISSING_BINARY_MESSAGE);
    }
  } catch {
    throw new Error(MISSING_BINARY_MESSAGE);
  }
}

const pageErrors = new WeakMap<Page, string[]>();

export interface BrowserLaunchOptions {
  headless?: boolean;
  width?: number;
  height?: number;
}

export interface BrowserSession {
  browser: Browser;
  page: Page;
  url: string;
}

export async function launchBrowser(
  url?: string,
  options?: BrowserLaunchOptions
): Promise<BrowserSession> {
  ensurePlaywright();

  const targetUrl =
    url ?? process.env.RELAY_IDE_URL ?? 'http://127.0.0.1:3456';
  const width = options?.width ?? 1280;
  const height = options?.height ?? 720;

  const browser = await chromium!.launch({
    headless: options?.headless ?? false,
  });

  try {
    const page = await browser.newPage();
    pageErrors.set(page, []);

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const errs = pageErrors.get(page) ?? [];
        errs.push(msg.text());
        pageErrors.set(page, errs);
      }
    });

    await page.setViewportSize({ width, height });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    return { browser, page, url: targetUrl };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function screenshot(
  session: BrowserSession,
  outPath: string
): Promise<void> {
  await session.page.screenshot({ path: outPath, fullPage: true });
}

export async function validatePage(
  session: BrowserSession
): Promise<{ ok: boolean; errors: string[] }> {
  // Give the page a moment to settle and emit any console messages
  await session.page.waitForTimeout(500);

  const errors = pageErrors.get(session.page) ?? [];
  const ok = errors.length === 0;
  return { ok, errors };
}

export async function closeBrowser(session: BrowserSession): Promise<void> {
  await session.browser.close();
}
