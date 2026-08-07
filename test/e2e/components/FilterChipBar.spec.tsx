import { test, expect } from '@playwright/test';

test.describe('FilterChipBar React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-filter-chip-bar.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders chips and counts', async ({ page }) => {
    const bar = page.locator('#default-bar-container .filter-chip-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.filter-chip')).toHaveCount(3);
    await expect(bar.locator('.chip-count')).toHaveCount(3);
  });

  test('marks active chips and toggles them', async ({ page }) => {
    const activeChip = page.locator('#interactive-bar-container .filter-chip', {
      hasText: 'Open',
    });
    await expect(activeChip).toHaveClass(/active/);

    await page
      .locator('#interactive-bar-container .filter-chip', { hasText: 'Review' })
      .click();
    await expect(page.locator('#active-state')).toHaveText(/open, review/);
    await expect(
      page.locator('#interactive-bar-container .filter-chip', {
        hasText: 'Review',
      })
    ).toHaveClass(/active/);
  });

  test('renders search input and clear button for active filters', async ({
    page,
  }) => {
    const search = page.locator('#interactive-bar-container .filter-search');
    const clear = page.locator('#interactive-bar-container .clear-chip');

    await expect(search).toHaveValue('fix');
    await expect(clear).toBeVisible();

    await search.fill('sessions');
    await expect(page.locator('#search-state')).toHaveText('Search: sessions');

    await clear.click();
    await expect(search).toHaveValue('');
    await expect(page.locator('#active-state')).toHaveText('Active: none');
    await expect(clear).toHaveCount(0);
  });

  test('screenshot - interactive state', async ({ page }) => {
    const container = page.locator('#interactive-bar-container');
    await expect(container).toBeVisible();

    await expect(container).toHaveScreenshot(
      'filter-chip-bar-interactive.png',
      {
        maxDiffPixels: 120,
        threshold: 0.2,
      }
    );
  });
});
