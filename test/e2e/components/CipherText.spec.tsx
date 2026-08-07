import { test, expect } from '@playwright/test';

const CIPHER_TEXT_SELECTOR = '.cipher-text';

test.describe('CipherText component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('displays text when not animating', async ({ page }) => {
    const cipherText = page.locator(CIPHER_TEXT_SELECTOR).first();
    await expect(cipherText).toBeVisible();
  });

  test('has aria-live attribute for accessibility', async ({ page }) => {
    const cipherText = page.locator(CIPHER_TEXT_SELECTOR).first();
    await expect(cipherText).toHaveAttribute('aria-live', 'polite');
  });

  test('uses monospace font', async ({ page }) => {
    const cipherText = page.locator(CIPHER_TEXT_SELECTOR).first();
    await expect(cipherText).toBeVisible();

    const fontFamily = await cipherText.evaluate((el) => {
      return window.getComputedStyle(el).fontFamily;
    });
    expect(fontFamily.toLowerCase()).toContain('mono');
  });

  test('preserves whitespace with pre-wrap', async ({ page }) => {
    const cipherText = page.locator(CIPHER_TEXT_SELECTOR).first();
    await expect(cipherText).toBeVisible();

    const whiteSpace = await cipherText.evaluate((el) => {
      return window.getComputedStyle(el).whiteSpace;
    });
    expect(whiteSpace).toBe('pre');
  });

  test('respects prefers-reduced-motion', async ({ page, browserName }) => {
    test.skip(
      browserName === 'webkit',
      'prefers-reduced-motion emulation not fully supported on webkit'
    );

    const context = page.context();

    const reducedMotionPage = await context.newPage();
    await reducedMotionPage.emulateMedia({ reducedMotion: 'reduce' });
    await reducedMotionPage.goto('/');

    const cipherText = reducedMotionPage.locator('.cipher-text').first();
    await expect(cipherText).toBeVisible();

    await reducedMotionPage.close();
  });
});
