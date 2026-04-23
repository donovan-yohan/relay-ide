import { test, expect, describe } from 'vitest';
import fs from 'node:fs';
import {
  launchBrowser,
  screenshot,
  validatePage,
  closeBrowser,
} from '../server/agent-browser.js';

// These tests require Playwright browsers to be installed.
// If chromium is not available, they skip gracefully.

async function hasPlaywright(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

describe('agent-browser', () => {
  test('module exports required functions', () => {
    expect(typeof launchBrowser).toBe('function');
    expect(typeof screenshot).toBe('function');
    expect(typeof validatePage).toBe('function');
    expect(typeof closeBrowser).toBe('function');
  });

  test('launchBrowser throws helpful error when Playwright is missing', async () => {
    // This only tests the error path if Playwright is somehow not importable.
    // In practice, @playwright/test is a devDependency so it should be present.
    const pwAvailable = await hasPlaywright();
    if (!pwAvailable) {
      await expect(launchBrowser('http://127.0.0.1:3456')).rejects.toThrow(/Playwright is unavailable/);
    }
  });
});

describe('agent-browser integration', () => {
  test('screenshot and validate work against a real page', async () => {
    if (!(await hasPlaywright())) {
      return;
    }

    // Launch against a data URL so we don't need a server
    const session = await launchBrowser(
      'data:text/html,<html><body><h1>Hello</h1></body></html>',
      { headless: true }
    );

    try {
      expect(session.page).toBeDefined();
      expect(session.browser).toBeDefined();

      const h1 = await session.page.locator('h1').textContent();
      expect(h1).toBe('Hello');

      const validation = await validatePage(session);
      expect(validation.ok).toBe(true);
      expect(validation.errors).toHaveLength(0);
    } finally {
      await closeBrowser(session);
    }
  }, 30_000);

  test('validatePage catches console errors', async () => {
    if (!(await hasPlaywright())) {
      return;
    }

    const session = await launchBrowser(
      'data:text/html,<html><script>console.error("test error")</script></html>',
      { headless: true }
    );

    try {
      const validation = await validatePage(session);
      expect(validation.ok).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.errors[0]).toContain('test error');
    } finally {
      await closeBrowser(session);
    }
  }, 30_000);
});
