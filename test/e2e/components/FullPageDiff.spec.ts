import { test, expect } from '@playwright/test';

test.describe('FullPageDiff review workspace compatibility entry', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-full-page-diff.html');
    await page.waitForSelector('.full-page-diff');
  });

  test('shows the compatibility header and unified review panel', async ({ page }) => {
    await expect(page.locator('.fpd-header')).toBeVisible();
    await expect(page.locator('.fpd-close-btn')).toContainText('[x] close');
    await expect(page.locator('.fpd-summary')).toContainText('utility rail review workspace');
    await expect(page.locator('.utility-review-panel')).toBeVisible();
    await expect(page.locator('.utility-review-footer')).toContainText('j/k or arrows files');
  });

  test('selects a changed file and updates the diff in place', async ({ page }) => {
    await expect(page.getByRole('option', { name: /a\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await page.getByRole('option', { name: /b\.ts/ }).click();

    await expect(page.getByRole('option', { name: /b\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.locator('.utility-review-title')).toContainText('src/b.ts');
    await expect(page.locator('.diff-viewer')).toContainText('new src/b.ts');
  });

  test('switches diff source and falls back to the available file list', async ({ page }) => {
    await page.getByRole('radio', { name: 'staged' }).click();

    await expect(page.getByRole('option', { name: /staged\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.locator('.utility-review-title')).toContainText('src/staged.ts');
    await expect(page.locator('.diff-viewer')).toContainText('context cached');
  });

  test('keeps the real store-guarded compatibility overlay mounted after seeding review state', async ({ page }) => {
    await expect(page.locator('.full-page-diff')).toBeVisible();
    await page.waitForTimeout(0);
    await expect(page.locator('.full-page-diff')).toBeVisible();
  });

  test('preserves keyboard review navigation immediately after opening', async ({ page }) => {
    await page.keyboard.press('j');

    await expect(page.getByRole('option', { name: /b\.ts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await page.keyboard.press('Escape');
    await expect(page.locator('.full-page-diff')).toHaveCount(0);
    await expect(page.locator('.utility-empty')).toContainText('closed');
  });
});
