import { test, expect } from '@playwright/test';

test.describe('StartWorkModal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-start-work-modal.html');
    await page.waitForLoadState('networkidle');
  });

  test('modal is closed by default', async ({ page }) => {
    await page.waitForSelector('#test-container');
    const backdrop = page.locator('.start-work-modal-backdrop');
    await expect(backdrop).not.toBeVisible();
  });

  test('opens GitHub issue modal', async ({ page }) => {
    await page.click('button:has-text("Open (GitHub issue)")');
    const modal = page.locator('.start-work-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.modal-title')).toContainText('Start Work');
  });

  test('shows ticket display for github issue', async ({ page }) => {
    await page.click('button:has-text("Open (GitHub issue)")');
    const modal = page.locator('.start-work-modal');
    await expect(modal).toBeVisible();
    const ticketValue = modal.locator('.ticket-info-value').first();
    await expect(ticketValue).toContainText('#42');
  });

  test('modal closes on Escape key', async ({ page }) => {
    await page.click('button:has-text("Open (GitHub issue)")');
    await expect(page.locator('.start-work-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.start-work-modal')).not.toBeVisible();
  });

  test('branch name input is pre-filled', async ({ page }) => {
    await page.click('button:has-text("Open (GitHub issue)")');
    const input = page.locator('#branch-name');
    await expect(input).toBeVisible();
    const value = await input.inputValue();
    expect(value).toBe('gh-42');
  });

  test('screenshot - github modal open', async ({ page }) => {
    await page.click('button:has-text("Open (GitHub issue)")');
    await expect(page.locator('.start-work-modal')).toBeVisible();
    await expect(page).toHaveScreenshot('start-work-modal-github.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
