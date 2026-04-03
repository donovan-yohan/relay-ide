import { test, expect } from '@playwright/test';

test.describe('DiffSourceToggle React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-diff-source-toggle.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders the toggle and updates the selected source', async ({
    page,
  }) => {
    const container = page.locator(
      '#interactive-toggle-container .diff-source-toggle'
    );
    await expect(container).toBeVisible();

    const buttons = container.locator('.toggle-option');
    await expect(buttons).toHaveCount(3);
    await expect(buttons.nth(0)).toHaveText('working tree');
    await expect(buttons.nth(1)).toHaveText('staged');
    await expect(buttons.nth(2)).toHaveText('vs develop');

    await expect(buttons.nth(0)).toHaveClass(/active/);
    await buttons.nth(1).click();
    await expect(page.locator('#source-state')).toHaveText('Source: staged');
    await expect(buttons.nth(1)).toHaveClass(/active/);
  });

  test('uses the supplied default branch label', async ({ page }) => {
    const buttons = page.locator('#branch-toggle-container .toggle-option');
    await expect(buttons.nth(2)).toHaveText('vs release/1.0');
  });

  test('applies radiogroup semantics', async ({ page }) => {
    const group = page.locator('#default-toggle-container .diff-source-toggle');
    await expect(group).toHaveAttribute('role', 'radiogroup');
    await expect(group).toHaveAttribute('aria-label', 'diff source');
    await expect(group.locator('.toggle-option').nth(0)).toHaveAttribute(
      'role',
      'radio'
    );
  });
});
