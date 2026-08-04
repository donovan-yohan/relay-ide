import { test, expect } from '@playwright/test';

test.describe('SearchableSelect React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-searchable-select.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders closed trigger with placeholder', async ({ page }) => {
    const trigger = page.locator('#closed-no-selection .ss-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger.locator('.ss-placeholder')).toHaveText('Select...');
  });

  test('renders closed trigger with selected value', async ({ page }) => {
    const trigger = page.locator('#closed-with-selection .ss-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger.locator('.ss-trigger-text')).toHaveText('Banana');
  });

  test('opens dropdown on trigger click', async ({ page }) => {
    await page.locator('#closed-no-selection .ss-trigger').click();
    await expect(
      page.locator('#closed-no-selection .ss-dropdown')
    ).toBeVisible();
    await expect(page.locator('#closed-no-selection .ss-input')).toBeVisible();
  });

  test('filters options on search input', async ({ page }) => {
    await page.locator('#closed-no-selection .ss-trigger').click();
    await page.locator('#closed-no-selection .ss-input').fill('er');
    const items = page.locator('#closed-no-selection .tui-menu-item');
    // "Cherry" and "Elderberry" + reset option
    await expect(items).toHaveCount(3);
  });

  test('shows no matches message for empty filter', async ({ page }) => {
    await page.locator('#closed-no-selection .ss-trigger').click();
    await page.locator('#closed-no-selection .ss-input').fill('zzz');
    await expect(
      page.locator('#closed-no-selection .ss-no-results')
    ).toBeVisible();
  });

  test('closes on Escape key', async ({ page }) => {
    await page.locator('#closed-no-selection .ss-trigger').click();
    await expect(page.locator('#closed-no-selection .ss-input')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.locator('#closed-no-selection .ss-trigger')
    ).toBeVisible();
    await expect(page.locator('#closed-no-selection .ss-input')).toHaveCount(0);
  });

  test('screenshot - closed states', async ({ page }) => {
    const container = page.locator('#closed-no-selection');
    await expect(container).toHaveScreenshot('searchable-select-closed.png', {
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });
});
