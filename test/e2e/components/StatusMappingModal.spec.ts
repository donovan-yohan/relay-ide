import { test, expect } from '@playwright/test';

test.describe('StatusMappingModal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-status-mapping-modal.html');
    await page.waitForLoadState('networkidle');
  });

  test('modal is closed by default', async ({ page }) => {
    await page.waitForSelector('#test-container');
    const backdrop = page.locator('.status-mapping-modal-backdrop');
    await expect(backdrop).not.toBeVisible();
  });

  test('modal opens when trigger is clicked', async ({ page }) => {
    await page.click('button:has-text("Open (no project key)")');
    const modal = page.locator('.status-mapping-modal');
    await expect(modal).toBeVisible();
  });

  test('modal closes on Escape key', async ({ page }) => {
    await page.click('button:has-text("Open (no project key)")');
    await expect(page.locator('.status-mapping-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.status-mapping-modal')).not.toBeVisible();
  });

  test('modal shows title', async ({ page }) => {
    await page.click('button:has-text("Open (no project key)")');
    await expect(page.locator('.modal-title')).toContainText('Jira');
  });

  test('screenshot - modal open', async ({ page }) => {
    await page.click('button:has-text("Open (no project key)")');
    await expect(page.locator('.status-mapping-modal')).toBeVisible();
    await expect(page).toHaveScreenshot('status-mapping-modal-open.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
