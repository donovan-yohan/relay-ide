import { test, expect } from '@playwright/test';

test.describe('UtilityRailBranchPanel React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-utility-rail-branch-panel.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders branch divergence metrics and commit lists', async ({
    page,
  }) => {
    await expect(page.locator('.branch-panel')).toBeVisible();
    await expect(page.getByText('divergence')).toBeVisible();
    await expect(page.getByText('feat/branch-panel')).toBeVisible();
    await expect(page.locator('.branch-metrics')).toContainText('ahead');
    await expect(page.locator('.branch-metrics')).toContainText('+42');
    await expect(page.getByText('add branch panel')).toBeVisible();
    await expect(page.getByText('backend contract')).toBeVisible();
    await expect(page.getByText('dirty tree')).toBeVisible();
  });

  test('refetches and persists base choice from selector', async ({ page }) => {
    const baseSelect = page.locator('#branch-base-select');
    await expect(baseSelect).toHaveValue('origin/nightly');

    await baseSelect.selectOption('origin/main');

    await expect(baseSelect).toHaveValue('origin/main');
    await expect(page.getByTestId('branch-base-state')).toHaveText(
      'origin/main'
    );
    await expect(page.locator('.branch-metrics')).toContainText('3');
  });

  test('keeps narrow viewport controls touch sized', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.branch-panel')).toBeVisible();

    for (const selector of [
      '#branch-base-select',
      '.branch-topbar .branch-button',
      '[data-testid="branch-open-changes"]',
      '[data-testid="branch-open-review"]',
    ]) {
      const box = await page.locator(selector).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    const metricColumns = await page.locator('.branch-metric').evaluateAll((els) =>
      new Set(els.map((el) => Math.round(el.getBoundingClientRect().left))).size
    );
    expect(metricColumns).toBe(2);
  });
});
