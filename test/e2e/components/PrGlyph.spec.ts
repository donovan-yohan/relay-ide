import { test, expect } from '@playwright/test';

test.describe('PrGlyph Component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-pr-glyph.html');
  });

  test('renders all status glyphs', async ({ page }) => {
    const container = page.locator('#all-glyphs-container');
    await expect(container).toBeVisible();

    const glyphs = container.locator('.glyph-item');
    await expect(glyphs).toHaveCount(8);
  });

  test('renders correct characters for each status', async ({ page }) => {
    const expectedChars: Record<string, string> = {
      draft: '◌',
      open: '○',
      'review-requested': '◎',
      'changes-requested': '✕',
      approved: '✓',
      merged: '●',
      closed: '⊘',
      unknown: '?',
    };

    for (const [status, char] of Object.entries(expectedChars)) {
      const glyph = page.locator(`#test-${status} .pr-glyph`);
      await expect(glyph).toHaveText(char);
    }
  });

  test('applies correct color classes', async ({ page }) => {
    const expectedClasses: Record<string, string> = {
      draft: 'pr-gray',
      open: 'pr-blue',
      'review-requested': 'pr-yellow',
      'changes-requested': 'pr-red',
      approved: 'pr-green',
      merged: 'pr-purple',
      closed: 'pr-red',
      unknown: 'pr-gray',
    };

    for (const [status, colorClass] of Object.entries(expectedClasses)) {
      const glyph = page.locator(`#test-${status} .pr-glyph`);
      await expect(glyph).toHaveClass(new RegExp(colorClass));
    }
  });

  test('has correct aria-label and title', async ({ page }) => {
    const expectedLabels: Record<string, string> = {
      draft: 'draft pr',
      open: 'open pr',
      'review-requested': 'review requested',
      'changes-requested': 'changes requested',
      approved: 'approved',
      merged: 'merged',
      closed: 'closed (not merged)',
      unknown: 'unknown',
    };

    for (const [status, label] of Object.entries(expectedLabels)) {
      const glyph = page.locator(`#test-${status} .pr-glyph`);
      await expect(glyph).toHaveAttribute('aria-label', label);
      await expect(glyph).toHaveAttribute('title', label);
    }
  });

  test('has role="img"', async ({ page }) => {
    const glyph = page.locator('#test-open .pr-glyph');
    await expect(glyph).toHaveAttribute('role', 'img');
  });

  test('screenshot comparison - all glyphs', async ({ page }) => {
    const container = page.locator('#all-glyphs-container');
    await expect(container).toHaveScreenshot('pr-glyph-all.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
