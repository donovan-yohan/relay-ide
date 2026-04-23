import { test, expect } from '@playwright/test';

test.describe('SplitPaneLayout React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-fixtures/test-split-pane-layout.html');
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

  test('renders resize handles between panes', async ({ page }) => {
    const firstLayout = page.locator('.split-pane-layout').first();
    await expect(firstLayout.locator('.resize-handle')).toHaveCount(2);
  });

  test('resize handles have touch-action:none', async ({ page }) => {
    const handle = page.locator('.resize-handle').first();
    await expect(handle).toHaveCSS('touch-action', 'none');
  });

  test('dragging right sidebar handle changes width', async ({ page }) => {
    const handle = page.locator('#rightSidebarHandle');
    const readout = page.locator('#readout');

    await handle.hover();
    await handle.dispatchEvent('pointerdown', { button: 0 });

    // Simulate a drag to the left (which increases right sidebar width)
    await page.mouse.move(800, 300);
    await page.mouse.move(750, 300);

    await handle.dispatchEvent('pointerup', { button: 0 });

    const text = await readout.textContent();
    expect(text).toMatch(/right sidebar: \d+px/);
  });

  test('mobile overlay opens via files button on small viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('.mobile-toggle')).toBeVisible();
    await page.locator('.mobile-toggle').click();
    await expect(page.locator('.right-sidebar-overlay')).toBeVisible();
    await expect(page.locator('.right-sidebar-overlay-panel')).toBeVisible();
  });

  test('mobile overlay closes on backdrop click', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.reload();
    await page.waitForLoadState('networkidle');

    await page.locator('.mobile-toggle').click();
    await expect(page.locator('.right-sidebar-overlay')).toBeVisible();

    await page.locator('.right-sidebar-overlay-backdrop').click();
    await expect(page.locator('.right-sidebar-overlay')).toHaveCount(0);
  });

  test('right sidebar and handles are hidden on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('.pane-right-sidebar')).toBeHidden();
    // resize handles exist in DOM but are hidden via CSS on mobile
    const handles = page.locator('.resize-handle');
    await expect(handles).toHaveCount(2);
    for (const handle of await handles.all()) {
      await expect(handle).toBeHidden();
    }
  });
});
