import { test, expect } from '@playwright/test';

test.describe('SplitPaneLayout React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-split-pane-layout.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders split pane with terminal, file viewer, and right sidebar', async ({
    page,
  }) => {
    await expect(page.locator('.split-pane-layout').first()).toBeVisible();
    await expect(page.locator('.pane-terminal').first()).toBeVisible();
    await expect(page.locator('.pane-file-viewer').first()).toBeVisible();
    await expect(page.locator('.pane-right-sidebar').first()).toBeVisible();
  });

  test('shows terminal only when file viewer is closed', async ({ page }) => {
    const terminalOnlySection = page.locator('.split-pane-layout').nth(1);
    await expect(terminalOnlySection).toBeVisible();
    await expect(terminalOnlySection.locator('.pane-terminal')).toBeVisible();
    await expect(terminalOnlySection.locator('.pane-file-viewer')).toHaveCount(
      0
    );
    await expect(
      terminalOnlySection.locator('.pane-right-sidebar')
    ).toHaveCount(0);
  });

  test('renders resize handles between panes', async ({ page }) => {
    const firstLayout = page.locator('.split-pane-layout').first();
    await expect(firstLayout.locator('.resize-handle')).toHaveCount(2);
  });

  test('resize handle drag activates handle on desktop', async ({ page }) => {
    const layout = page.locator('.split-pane-layout').first();
    const handle = layout.locator('.resize-handle').last();

    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    await page.mouse.move(handleBox!.x + 4, handleBox!.y + 50);
    await page.mouse.down();

    // The handle should have the 'active' class while dragging
    await expect(handle).toHaveClass(/active/);

    await page.mouse.move(handleBox!.x - 100, handleBox!.y + 50, { steps: 5 });
    await page.mouse.up();

    // After mouse up, active class should be removed
    await expect(handle).not.toHaveClass(/active/);
  });

  test('mobile overlay renders on small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    // Third layout has rightSidebarMobileOpen=true
    const overlay = page.locator('.right-sidebar-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.right-sidebar-overlay-panel')).toBeVisible();
    await expect(overlay).toHaveAttribute('role', 'dialog');
    await expect(overlay).toHaveAttribute('aria-modal', 'true');
  });

  test('mobile overlay closes on backdrop click', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const overlay = page.locator('.right-sidebar-overlay');
    await expect(overlay).toBeVisible();
    await overlay.locator('.right-sidebar-overlay-backdrop').click();
    await expect(overlay).not.toBeVisible();
  });

  test('screenshot matches baseline', async ({ page }) => {
    await expect(page).toHaveScreenshot('split-pane-layout.png', {
      fullPage: true,
    });
  });
});
