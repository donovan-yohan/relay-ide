import { test, expect } from '@playwright/test';

const isExpectedError = (msg: string) => {
  return msg.includes('401 (Unauthorized)') || msg.includes('auth');
};

test.describe('smoke', () => {
  test('app loads successfully', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!isExpectedError(text)) {
          errors.push(text);
        }
      }
    });

    await page.goto('/');

    await expect(page).toHaveTitle(/relay/i);

    expect(errors).toHaveLength(0);
  });

  test('auth flow matches configured PIN mode', async ({ page }) => {
    await page.goto('/');

    const setPinButton = page.getByRole('button', { name: /set PIN/i });

    if (process.env.NO_PIN === '1') {
      await expect(page.locator('.main-app')).toBeVisible({ timeout: 10000 });
      await expect(setPinButton).toHaveCount(0);
    } else {
      await expect(setPinButton).toBeVisible({ timeout: 10000 });
    }
  });

  test('no console errors on load', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!isExpectedError(text)) {
          errors.push(`Console error: ${text}`);
        }
      }
    });

    page.on('pageerror', (error) => {
      errors.push(`Page error: ${error.message}`);
    });

    await page.goto('/');

    await page.waitForLoadState('networkidle');

    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });
});

test.describe('visual regression', () => {
  test('screenshot comparison', async ({ page }) => {
    await page.goto('/');

    await page.waitForLoadState('networkidle');

    await expect(page).toHaveScreenshot('homepage.png', {
      maxDiffPixels: 1000,
      threshold: 0.2,
    });
  });

  test('responsive layout - mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/');

    await expect(page).toHaveScreenshot('mobile-homepage.png', {
      maxDiffPixels: 1000,
      threshold: 0.2,
    });
  });

  test('responsive layout - tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });

    await page.goto('/');

    await expect(page).toHaveScreenshot('tablet-homepage.png', {
      maxDiffPixels: 1000,
      threshold: 0.2,
    });
  });

  test('responsive layout - desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });

    await page.goto('/');

    await expect(page).toHaveScreenshot('desktop-homepage.png', {
      maxDiffPixels: 1000,
      threshold: 0.2,
    });
  });
});
