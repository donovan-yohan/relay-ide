import { test, expect } from '@playwright/test';

test.describe('PrRow long branch mobile layout', () => {
  test('truncates branch identity without horizontal row overflow at 390px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto('/test-pr-row-long.html');
    await page.waitForLoadState('networkidle');

    const row = page.locator('.pr-row');
    await expect(row).toBeVisible();
    await expect(page.locator('.pr-row__branch')).toHaveAttribute(
      'title',
      /feature\/super-long-mobile-branch-name.* → release\/another-extremely-long-base-branch-name/
    );

    const metrics = await page.evaluate(() => {
      const fixture = document.querySelector<HTMLElement>('.pr-row-long-fixture');
      const row = document.querySelector<HTMLElement>('.pr-row');
      const branch = document.querySelector<HTMLElement>('.pr-row__branch');
      const title = document.querySelector<HTMLElement>('.pr-row__title');
      const actions = document.querySelector<HTMLElement>('.pr-row__actions');
      if (!fixture || !row || !branch || !title || !actions) {
        throw new Error('missing PrRow fixture elements');
      }
      return {
        fixtureClientWidth: fixture.clientWidth,
        fixtureScrollWidth: fixture.scrollWidth,
        rowClientWidth: row.clientWidth,
        rowScrollWidth: row.scrollWidth,
        branchClientWidth: branch.clientWidth,
        branchScrollWidth: branch.scrollWidth,
        titleClientWidth: title.clientWidth,
        actionsClientWidth: actions.clientWidth,
        branchRefOverflow: Array.from(
          document.querySelectorAll<HTMLElement>('.pr-row__branch-ref')
        ).map((ref) => ref.scrollWidth > ref.clientWidth),
      };
    });

    expect(metrics.fixtureScrollWidth).toBeLessThanOrEqual(metrics.fixtureClientWidth);
    expect(metrics.rowScrollWidth).toBeLessThanOrEqual(metrics.rowClientWidth);
    expect(metrics.branchClientWidth).toBeLessThan(metrics.rowClientWidth);
    expect(metrics.branchRefOverflow).toContain(true);
    expect(metrics.titleClientWidth).toBeGreaterThan(0);
    expect(metrics.actionsClientWidth).toBeGreaterThan(0);
  });
});
