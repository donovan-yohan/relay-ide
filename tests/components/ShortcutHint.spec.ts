import { test, expect } from '@playwright/test';

test.describe('ShortcutHint Component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-shortcut-hint.html');
  });

  test('renders shortcut hint for action with shortcut', async ({ page }) => {
    const hint = page.locator('.hint-row').filter({ hasText: 'With shortcut (mod+shift+n)' }).locator('.shortcut-hint');
    await expect(hint).toBeVisible();
    
    const text = await hint.textContent();
    expect(text).toBeTruthy();
    expect(text!.length).toBeGreaterThan(0);
  });

  test('renders simple shortcut correctly', async ({ page }) => {
    const hint = page.locator('.hint-row').filter({ hasText: 'With shortcut (mod+r)' }).locator('.shortcut-hint');
    await expect(hint).toBeVisible();
    
    const text = await hint.textContent();
    expect(text).toBeTruthy();
  });

  test('renders global shortcut', async ({ page }) => {
    const hint = page.locator('.hint-row').filter({ hasText: 'With global shortcut (mod+k)' }).locator('.shortcut-hint');
    await expect(hint).toBeVisible();
    
    const text = await hint.textContent();
    expect(text).toBeTruthy();
  });

  test('does not render for action without shortcut', async ({ page }) => {
    const row = page.locator('.hint-row').filter({ hasText: 'Without shortcut:' });
    const hint = row.locator('.shortcut-hint');
    await expect(hint).not.toBeVisible();
  });

  test('does not render for non-existent action', async ({ page }) => {
    const row = page.locator('.hint-row').filter({ hasText: 'Non-existent action:' });
    const hint = row.locator('.shortcut-hint');
    await expect(hint).not.toBeVisible();
  });

  test('applies custom className', async ({ page }) => {
    const hint = page.locator('.hint-row').filter({ hasText: 'With custom className' }).locator('.shortcut-hint');
    await expect(hint).toHaveClass(/custom-hint/);
    await expect(hint).toHaveClass(/shortcut-hint/);
  });

  test('has correct styling', async ({ page }) => {
    const hint = page.locator('.shortcut-hint').first();
    
    await expect(hint).toHaveCSS('font-family', /monospace/);
    await expect(hint).toHaveCSS('border-width', '1px');
    await expect(hint).toHaveCSS('border-style', 'solid');
    await expect(hint).toHaveCSS('padding-top', '1px');
    await expect(hint).toHaveCSS('padding-right', '4px');
    await expect(hint).toHaveCSS('border-radius', '0px');
    await expect(hint).toHaveCSS('white-space', 'nowrap');
  });

  test('screenshot comparison', async ({ page }) => {
    const container = page.locator('.test-section');
    await expect(container).toHaveScreenshot('shortcut-hint-component.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });

  test('displays platform-appropriate modifier key', async ({ page, browserName }) => {
    const hint = page.locator('.hint-row').filter({ hasText: 'With shortcut (mod+r)' }).locator('.shortcut-hint');
    const text = await hint.textContent();
    
    expect(text).toMatch(/⌘|ctrl/i);
  });
});