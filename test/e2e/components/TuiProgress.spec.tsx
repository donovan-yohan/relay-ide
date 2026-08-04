import { test, expect } from '@playwright/test';

test.describe('TuiProgress React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/test-tui-progress.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders bar variants', async ({ page }) => {
    await expect(page.locator('#bar-50')).toHaveText('[█████░░░░░] 50%');
    await expect(page.locator('#bar-clamped')).toHaveText('[████████] 100%');
  });

  test('renders spinner variants with reduced motion fallback', async ({
    page,
  }) => {
    await expect(page.locator('#braille-spinner')).toHaveText('⠋');
    await expect(page.locator('#line-spinner')).toHaveText('|');
    await expect(page.locator('#knight-rider')).toHaveText('[████░░░░░░░░]');
  });

  test('preserves accessibility and styling', async ({ page }) => {
    const progress = page.locator('#default-progress');

    await expect(progress).toHaveAttribute('role', 'status');
    await expect(progress).toHaveAttribute('aria-label', 'loading');
    await expect(progress).toHaveCSS('white-space', 'pre');
  });
});
