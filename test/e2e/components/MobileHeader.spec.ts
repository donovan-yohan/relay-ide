import { test, expect } from '@playwright/test';

test.describe('MobileHeader React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.goto('/test-mobile-header.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders the mobile header content', async ({ page }) => {
    const header = page.locator('#visible-container .mobile-header');
    await expect(header).toBeVisible();
    await expect(header).toContainText('Active Session');
    await expect(header.getByLabel('Open sessions menu')).toBeVisible();
    await expect(header.getByLabel('Open files sidebar')).toBeVisible();
    await expect(header.getByLabel('Open command palette')).toBeVisible();
  });

  test('fires click handlers for all buttons', async ({ page }) => {
    const header = page.locator('#visible-container .mobile-header');

    await header.getByLabel('Open sessions menu').click();
    await header.getByLabel('Open files sidebar').click();
    await header.getByLabel('Open command palette').click();

    await expect(page.locator('#menu-count')).toHaveText('menu: 1');
    await expect(page.locator('#files-count')).toHaveText('files: 1');
    await expect(page.locator('#command-count')).toHaveText('command: 1');
  });

  test('respects the hidden prop', async ({ page }) => {
    await expect(page.locator('#hidden-container .mobile-header')).toBeHidden();
  });
});
