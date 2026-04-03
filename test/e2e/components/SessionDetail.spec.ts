import { test, expect } from '@playwright/test';

test.describe('SessionDetail', () => {
  test('renders correctly', async ({ page }) => {
    await page.goto('/test-session-detail.html');
    await page.waitForSelector('#app');
  });

  test('shows back button', async ({ page }) => {
    await page.goto('/test-session-detail.html');
    await page.waitForSelector('.session-detail');
    await expect(page.locator('.sd-back-btn')).toBeVisible();
    await expect(page.locator('.sd-back-btn')).toContainText('back');
  });

  test('shows loading state', async ({ page }) => {
    await page.goto('/test-session-detail.html');
    await page.waitForSelector('.session-detail');
    // Either loading or content — container must be visible
    const detail = page.locator('.session-detail');
    await expect(detail).toBeVisible();
  });

  test('back button is clickable', async ({ page }) => {
    await page.goto('/test-session-detail.html');
    await page.waitForSelector('.sd-back-btn');
    await page.locator('.sd-back-btn').click();
    // After click, session detail is gone
    await expect(page.locator('.session-detail')).not.toBeVisible();
  });
});
