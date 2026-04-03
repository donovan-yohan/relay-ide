import { test, expect } from '@playwright/test';

test.describe('TuiMenuItem React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-tui-menu-item.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders default, icon, danger, and disabled states', async ({
    page,
  }) => {
    await expect(page.locator('#menu-default')).toHaveClass(/tui-menu-item/);
    await expect(page.locator('#menu-icon .tui-menu-item__icon')).toBeVisible();
    await expect(page.locator('#menu-danger')).toHaveClass(
      /tui-menu-item--danger/
    );
    await expect(page.locator('#menu-disabled')).toHaveClass(
      /tui-menu-item--disabled/
    );
  });

  test('triggers mouse and keyboard activation', async ({ page }) => {
    const defaultItem = page.locator('#menu-default');
    const keyboardItem = page.locator('#menu-keyboard');
    const mouseDownCount = page.locator('#mousedown-count');
    const clickCount = page.locator('#click-count');

    await expect(mouseDownCount).toHaveText('0');
    await expect(clickCount).toHaveText('0');

    await defaultItem.click();
    await expect(mouseDownCount).toHaveText('1');
    await expect(clickCount).toHaveText('1');

    await keyboardItem.focus();
    await page.keyboard.press('Enter');
    await expect(mouseDownCount).toHaveText('2');
  });

  test('disabled item is not interactive', async ({ page }) => {
    const disabledItem = page.locator('#menu-disabled');
    await expect(disabledItem).toHaveAttribute('tabindex', '-1');
    await disabledItem.click({ force: true });
    await expect(page.locator('#mousedown-count')).toHaveText('0');
  });

  test('keyboard focus is visible on active item', async ({ page }) => {
    const item = page.locator('#menu-default');
    await item.focus();
    await expect(item).toBeFocused();
    await expect(item).toHaveAttribute('role', 'menuitem');
  });
});
