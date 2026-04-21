import { test, expect } from '@playwright/test';

test.describe('DataTable React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-data-table.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders column headers', async ({ page }) => {
    const header = page.locator('#default-table .data-table-header');
    await expect(header).toBeVisible();
    await expect(header.locator('.data-table-th')).toHaveCount(3);
  });

  test('renders data rows', async ({ page }) => {
    const rows = page.locator('#default-table .data-table-row');
    await expect(rows).toHaveCount(4);
  });

  test('shows sort indicator on sortable column click', async ({ page }) => {
    await page.locator('#default-table .sort-trigger').first().click();
    // After second click on same column, direction flips
    await page.locator('#default-table .sort-trigger').first().click();
    const indicator = page.locator('#default-table .sort-indicator');
    await expect(indicator).toBeVisible();
  });

  test('shows loading skeleton state', async ({ page }) => {
    const skeletons = page.locator('#loading-table .skeleton-row');
    await expect(skeletons).toHaveCount(3);
    await expect(
      page.locator('#loading-table .skeleton-line').first()
    ).toBeVisible();
  });

  test('shows error message', async ({ page }) => {
    const error = page.locator('#error-table .state-message--error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Failed to load data.');
  });

  test('shows empty message', async ({ page }) => {
    const empty = page.locator('#empty-table .state-message');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No sessions found.');
  });

  test('renders grouped rows with group headers', async ({ page }) => {
    const groupHeaders = page.locator('#grouped-table .group-header');
    await expect(groupHeaders.first()).toBeVisible();
  });

  test('toggles group visibility on header click', async ({ page }) => {
    const firstHeader = page.locator('#grouped-table .group-header').first();
    const initialRows = await page
      .locator('#grouped-table .data-table-row')
      .count();
    await firstHeader.click();
    const newRows = await page
      .locator('#grouped-table .data-table-row')
      .count();
    expect(newRows).toBeLessThan(initialRows);
  });

  test('screenshot - default table', async ({ page }) => {
    const container = page.locator('#default-table');
    await expect(container).toHaveScreenshot('data-table-default.png', {
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });
});
