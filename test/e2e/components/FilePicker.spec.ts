import { test, expect } from '@playwright/test';

test.describe('FilePicker', () => {
  test('renders correctly', async ({ page }) => {
    await page.goto('/test-file-picker.html');
    await page.waitForSelector('#app');
  });

  test('shows file picker overlay when open', async ({ page }) => {
    await page.goto('/test-file-picker.html');
    await page.waitForSelector('.file-picker-overlay');
    await expect(page.locator('.file-picker-overlay')).toBeVisible();
  });

  test('shows file picker dialog', async ({ page }) => {
    await page.goto('/test-file-picker.html');
    await page.waitForSelector('.file-picker');
    await expect(page.locator('.file-picker')).toBeVisible();
  });

  test('shows search input', async ({ page }) => {
    await page.goto('/test-file-picker.html');
    await page.waitForSelector('.file-picker-input-row');
    await expect(page.locator('.file-picker-input-row')).toBeVisible();
    await expect(page.locator('.file-picker-prompt')).toContainText('>');
  });

  test('shows footer with keyboard hints', async ({ page }) => {
    await page.goto('/test-file-picker.html');
    await page.waitForSelector('.file-picker-footer');
    await expect(page.locator('.file-picker-footer')).toBeVisible();
  });

  test('closes on escape key', async ({ page }) => {
    await page.goto('/test-file-picker.html');
    await page.waitForSelector('.file-picker');
    await page.keyboard.press('Escape');
    await expect(page.locator('.file-picker-overlay')).not.toBeVisible();
  });
});
