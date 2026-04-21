import { test, expect } from '@playwright/test';

test.describe('BranchSwitcher React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-branch-switcher.html');
    await page.waitForLoadState('networkidle');
  });

  test('opens the dropdown, filters branches, and creates new branches', async ({
    page,
  }) => {
    const trigger = page.locator(
      '#interactive-switcher-container .branch-trigger'
    );

    await trigger.click();
    const dropdown = page.locator(
      '#interactive-switcher-container .branch-dropdown'
    );
    await expect(dropdown).toBeVisible();

    const filter = page.locator(
      '#interactive-switcher-container .branch-filter'
    );
    await filter.fill('feature');
    await expect(
      page.locator(
        '#interactive-switcher-container .branch-list .tui-menu-item'
      )
    ).toHaveCount(1);
    await expect(
      page.locator('#interactive-switcher-container .branch-create')
    ).toContainText('Create "feature"');

    await filter.fill('hotfix/new');
    await expect(
      page.locator('#interactive-switcher-container .branch-create')
    ).toContainText('Create "hotfix/new"');
    await page
      .locator('#interactive-switcher-container .branch-create')
      .click();
    await expect(page.locator('#created-branch-state')).toHaveText(
      'Create: hotfix/new'
    );
  });

  test('switches branches and preserves jump interactions', async ({
    page,
  }) => {
    await page
      .locator('#interactive-switcher-container .branch-trigger')
      .click();
    await page
      .locator('#interactive-switcher-container .branch-filter')
      .fill('topic/next');
    await page
      .locator('#interactive-switcher-container .branch-list .tui-menu-item', {
        hasText: 'topic/next',
      })
      .click();

    await expect(page.locator('#current-branch-state')).toHaveText(
      'Current: topic/next'
    );

    await page
      .locator('#interactive-switcher-container .branch-trigger')
      .click();
    await page
      .locator('#interactive-switcher-container .branch-filter')
      .fill('bugfix');
    await expect(
      page.locator('#interactive-switcher-container .branch-worktree-name')
    ).toHaveText('(login)');
    await page
      .locator('#interactive-switcher-container .branch-jump-btn')
      .dispatchEvent('mousedown');
    await expect(page.locator('#session-state')).toHaveText(
      'Session: /repos/demo/.worktrees/login'
    );
  });

  test('disables interaction when requested', async ({ page }) => {
    const disabledTrigger = page.locator(
      '#disabled-switcher-container .branch-trigger'
    );
    await expect(disabledTrigger).toHaveClass(/branch-disabled/);
    await disabledTrigger.click({ force: true });
    await expect(
      page.locator('#disabled-switcher-container .branch-dropdown')
    ).toHaveCount(0);
  });
});
