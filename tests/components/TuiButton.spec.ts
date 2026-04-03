import { test, expect } from '@playwright/test';

test.describe('TuiButton Component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-tui-button.html');
  });

  test('renders primary button by default', async ({ page }) => {
    const button = page.locator('#test-primary');
    await expect(button).toBeVisible();
    await expect(button).toHaveClass(/tui-btn--primary/);
    await expect(button).toHaveText('Primary');
  });

  test('renders all variants', async ({ page }) => {
    const variants = ['primary', 'ghost', 'danger', 'success', 'info'];
    
    for (const variant of variants) {
      const button = page.locator(`#test-${variant}`);
      await expect(button).toHaveClass(new RegExp(`tui-btn--${variant}`));
    }
  });

  test('renders all sizes', async ({ page }) => {
    const defaultBtn = page.locator('#test-default-size');
    const smBtn = page.locator('#test-sm-size');
    const iconBtn = page.locator('#test-icon-size');
    
    await expect(defaultBtn).not.toHaveClass(/tui-btn--sm/);
    await expect(defaultBtn).not.toHaveClass(/tui-btn--icon/);
    
    await expect(smBtn).toHaveClass(/tui-btn--sm/);
    await expect(iconBtn).toHaveClass(/tui-btn--icon/);
  });

  test('disabled state', async ({ page }) => {
    const disabledBtn = page.locator('#test-disabled');
    await expect(disabledBtn).toBeDisabled();
    await expect(disabledBtn).toHaveClass(/tui-btn--disabled/);
  });

  test('renders as anchor when href provided', async ({ page }) => {
    const link = page.locator('#test-link');
    await expect(link).toHaveAttribute('href', '/test');
    await expect(link).toHaveText('Link Button');
  });

  test('click handler works', async ({ page }) => {
    const clickBtn = page.locator('#test-click');
    const clickCount = page.locator('#click-count');
    
    await expect(clickCount).toHaveText('0');
    
    await clickBtn.click();
    await expect(clickCount).toHaveText('1');
    
    await clickBtn.click();
    await expect(clickCount).toHaveText('2');
  });

  test('disabled button does not trigger click', async ({ page }) => {
    const disabledBtn = page.locator('#test-disabled-click');
    const clickCount = page.locator('#disabled-click-count');
    
    await expect(clickCount).toHaveText('0');
    
    await disabledBtn.click({ force: true });
    await expect(clickCount).toHaveText('0');
  });

  test('screenshot comparison - primary button', async ({ page }) => {
    const button = page.locator('#test-primary');
    await expect(button).toHaveScreenshot('tui-button-primary.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });

  test('screenshot comparison - all variants', async ({ page }) => {
    const container = page.locator('#variants-container');
    await expect(container).toHaveScreenshot('tui-button-variants.png', {
      maxDiffPixels: 500,
      threshold: 0.1,
    });
  });

  test('screenshot comparison - sizes', async ({ page }) => {
    const container = page.locator('#sizes-container');
    await expect(container).toHaveScreenshot('tui-button-sizes.png', {
      maxDiffPixels: 500,
      threshold: 0.1,
    });
  });

  test('hover state', async ({ page }) => {
    const button = page.locator('#test-primary');
    await button.hover();
    
    await expect(button).toHaveCSS('border-width', '3px');
    await expect(button).toHaveCSS('border-style', 'double');
  });

  test('keyboard accessibility', async ({ page }) => {
    const button = page.locator('#test-primary');
    
    await button.focus();
    await expect(button).toBeFocused();
    
    await page.keyboard.press('Enter');
    const clickCount = page.locator('#click-count');
    await expect(clickCount).toHaveText('1');
  });
});