import { test, expect } from '@playwright/test';

test.describe('Terminal React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-terminal.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders terminal wrapper', async ({ page }) => {
    const wrapper = page.locator('.terminal-wrapper');
    await expect(wrapper).toBeVisible();
  });

  test('renders terminal container', async ({ page }) => {
    const container = page.locator('.terminal-container');
    await expect(container).toBeVisible();
  });

  test('renders custom scrollbar', async ({ page }) => {
    const scrollbar = page.locator('.terminal-scrollbar');
    await expect(scrollbar).toBeVisible();
  });

  test('renders xterm canvas', async ({ page }) => {
    await page.waitForSelector('.xterm-viewport', { timeout: 5000 });
    const xterm = page.locator('.xterm-viewport');
    await expect(xterm).toBeVisible();
  });

  test('locks xterm viewport to the available frame', async ({ page }) => {
    await page.waitForSelector('.xterm-viewport', { timeout: 5000 });
    await page.getByRole('button', { name: /write scrollback/i }).click();

    const metrics = await page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.terminal-test-frame');
      const container = document.querySelector<HTMLElement>(
        '.terminal-container'
      );
      const viewport = document.querySelector<HTMLElement>('.xterm-viewport');
      const screen = document.querySelector<HTMLElement>('.xterm-screen');
      if (!frame || !container || !viewport || !screen) return null;
      return {
        bodyScrollHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        frameClientHeight: frame.clientHeight,
        containerClientHeight: container.clientHeight,
        viewportClientHeight: viewport.clientHeight,
        viewportOverflowY: getComputedStyle(viewport).overflowY,
        screenOverflow: getComputedStyle(screen).overflow,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.bodyScrollHeight).toBeLessThanOrEqual(
      metrics!.viewportHeight
    );
    expect(metrics!.containerClientHeight).toBeLessThanOrEqual(
      metrics!.frameClientHeight
    );
    expect(metrics!.viewportClientHeight).toBeLessThanOrEqual(
      metrics!.containerClientHeight
    );
    expect(metrics!.viewportOverflowY).toBe('hidden');
    expect(metrics!.screenOverflow).toBe('hidden');
  });

  test('focus button focuses terminal', async ({ page }) => {
    const focusBtn = page.getByRole('button', { name: /focus/i });
    await expect(focusBtn).toBeVisible();
    await focusBtn.click();
  });

  test('fit button resizes terminal', async ({ page }) => {
    const fitBtn = page.getByRole('button', { name: /fit/i });
    await expect(fitBtn).toBeVisible();
    await fitBtn.click();
  });

  test('shows zoom overlay on desktop after zoom', async ({ page }) => {
    const zoomOverlay = page.locator('.zoom-overlay');
    await expect(zoomOverlay).toBeVisible();
    await expect(zoomOverlay).not.toHaveClass(/visible/);
  });
});
