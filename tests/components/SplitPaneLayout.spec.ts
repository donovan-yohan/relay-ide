import { test, expect } from '@playwright/test';

test.describe('SplitPaneLayout React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-split-pane-layout.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders split pane with terminal, file viewer, and right sidebar', async ({ page }) => {
    await expect(page.locator('.split-pane-layout').first()).toBeVisible();
    await expect(page.locator('.pane-terminal').first()).toBeVisible();
    await expect(page.locator('.pane-file-viewer').first()).toBeVisible();
    await expect(page.locator('.pane-right-sidebar').first()).toBeVisible();
  });

  test('shows terminal only when file viewer is closed', async ({ page }) => {
    const terminalOnlySection = page.locator('.split-pane-layout').nth(1);
    await expect(terminalOnlySection).toBeVisible();
    await expect(terminalOnlySection.locator('.pane-terminal')).toBeVisible();
    await expect(terminalOnlySection.locator('.pane-file-viewer')).toHaveCount(0);
    await expect(terminalOnlySection.locator('.pane-right-sidebar')).toHaveCount(0);
  });

  test('renders resize handles between panes', async ({ page }) => {
    const firstLayout = page.locator('.split-pane-layout').first();
    await expect(firstLayout.locator('.resize-handle')).toHaveCount(2);
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('split-pane-layout.png', { fullPage: true });
  });
});
