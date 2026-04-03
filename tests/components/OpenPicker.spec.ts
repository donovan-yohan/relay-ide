import { test, expect } from '@playwright/test';

test.describe('OpenPicker React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-open-picker.html');
    await page.waitForLoadState('networkidle');
  });

  test('trigger button is visible', async ({ page }) => {
    await expect(page.locator('#open-picker-btn')).toBeVisible();
  });

  test('opens picker on button click', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    await expect(page.locator('.open-picker')).toBeVisible();
    await expect(page.locator('.open-picker__panel')).toBeVisible();
  });

  test('input receives focus when opened', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    const input = page.locator('.open-picker__input');
    await expect(input).toBeFocused();
  });

  test('renders all items', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    const items = page.locator('.open-picker__item');
    await expect(items).toHaveCount(6);
  });

  test('filters items on typing', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    await page.locator('.open-picker__input').fill('session');
    const items = page.locator('.open-picker__item');
    await expect(items).toHaveCount(5);
  });

  test('shows empty message for no results', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    await page.locator('.open-picker__input').fill('zzz');
    await expect(page.locator('.open-picker__empty')).toHaveText('No results');
  });

  test('closes on Escape key', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    await expect(page.locator('.open-picker')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.open-picker')).toHaveCount(0);
  });

  test('closes on backdrop click', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    await expect(page.locator('.open-picker')).toBeVisible();
    await page.locator('.open-picker').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.open-picker')).toHaveCount(0);
  });

  test('navigates with arrow keys', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    await page.keyboard.press('ArrowDown');
    const secondItem = page.locator('.open-picker__item').nth(1);
    await expect(secondItem).toHaveClass(/open-picker__item--focused/);
  });

  test('selects item on Enter key', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    await page.keyboard.press('Enter');
    await expect(page.locator('.open-picker')).toHaveCount(0);
    await expect(page.locator('#picker-selected')).toContainText('Alpha session');
  });

  test('screenshot - open picker', async ({ page }) => {
    await page.locator('#open-picker-btn').click();
    await expect(page.locator('.open-picker__panel')).toBeVisible();
    await expect(page.locator('.open-picker')).toHaveScreenshot('open-picker-open.png', {
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });
});
