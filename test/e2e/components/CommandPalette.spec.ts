import { test, expect } from '@playwright/test';

test.describe('CommandPalette React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-command-palette.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders open button', async ({ page }) => {
    const btn = page.getByRole('button', { name: /open command palette/i });
    await expect(btn).toBeVisible();
  });

  test('opens palette when button is clicked', async ({ page }) => {
    await page.getByRole('button', { name: /open command palette/i }).click();
    await expect(page.locator('.palette-overlay')).toBeVisible();
    await expect(page.locator('.palette')).toBeVisible();
  });

  test('shows search input when open', async ({ page }) => {
    await page.getByRole('button', { name: /open command palette/i }).click();
    const input = page.locator('.palette-search-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('shows tab navigation', async ({ page }) => {
    await page.getByRole('button', { name: /open command palette/i }).click();
    await expect(page.locator('.palette-tabs')).toBeVisible();
    await expect(page.locator('.palette-tab').first()).toBeVisible();
  });

  test('closes on Escape key', async ({ page }) => {
    await page.getByRole('button', { name: /open command palette/i }).click();
    await expect(page.locator('.palette-overlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette-overlay')).not.toBeVisible();
  });

  test('filters results as user types', async ({ page }) => {
    await page.getByRole('button', { name: /open command palette/i }).click();
    await page.locator('.palette-search-input').fill('my-project');
    await expect(page.locator('.palette-item')).toBeVisible();
  });

  test('shows footer hints on desktop', async ({ page }) => {
    await page.getByRole('button', { name: /open command palette/i }).click();
    await expect(page.locator('.palette-footer')).toBeVisible();
    await expect(page.locator('.hint').first()).toBeVisible();
  });

  test('screenshot matches baseline', async ({ page }) => {
    await page.getByRole('button', { name: /open command palette/i }).click();
    await expect(page).toHaveScreenshot('command-palette.png', {
      fullPage: true,
    });
  });
});
