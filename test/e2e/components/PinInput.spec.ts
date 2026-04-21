import { test, expect } from '@playwright/test';

test.describe('PinInput component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-pin-input.html');
  });

  test('renders with placeholder text', async ({ page }) => {
    const pinInput = page.locator('.pin-input');
    await expect(pinInput).toBeVisible();
    await expect(page.locator('.pin-placeholder')).toHaveText('Enter PIN');
  });

  test('focuses on click', async ({ page }) => {
    const pinInput = page.locator('#test-basic');
    await pinInput.click();
    await expect(pinInput).toHaveClass(/focused/);
  });

  test('hides placeholder when focused', async ({ page }) => {
    const pinInput = page.locator('#test-basic');
    await pinInput.click();
    await expect(page.locator('.pin-placeholder')).not.toBeVisible();
  });

  test('shows dots for entered characters', async ({ page }) => {
    const pinInput = page.locator('#test-basic');
    await pinInput.click();
    await page.keyboard.type('1234');

    const dots = page.locator('.pin-dot');
    await expect(dots).toHaveCount(4);
  });

  test('shows blinking cursor when focused', async ({ page }) => {
    const pinInput = page.locator('#test-basic');
    await pinInput.click();
    await expect(page.locator('.pin-cursor')).toBeVisible();
  });

  test('masks input as password', async ({ page }) => {
    const hiddenInput = page.locator('#test-basic');
    await expect(hiddenInput).toHaveAttribute('type', 'password');
  });

  test('respects maxLength attribute', async ({ page }) => {
    const hiddenInput = page.locator('#test-maxlength');
    const maxLength = await hiddenInput.getAttribute('maxlength');
    expect(maxLength).toBe('6');
  });

  test('applies error styling', async ({ page }) => {
    const pinInput = page.locator('#test-error').locator('..');
    await expect(pinInput).toHaveClass(/error/);
  });

  test('applies disabled styling', async ({ page }) => {
    const pinInput = page.locator('#test-disabled').locator('..');
    await expect(pinInput).toHaveClass(/disabled/);
  });

  test('handles numeric input mode on mobile', async ({ page }) => {
    const hiddenInput = page.locator('#test-basic');
    await expect(hiddenInput).toHaveAttribute('inputmode', 'numeric');
  });

  test('clears input on backspace', async ({ page }) => {
    const pinInput = page.locator('#test-basic');
    await pinInput.click();
    await page.keyboard.type('1234');

    let dots = page.locator('.pin-dot');
    await expect(dots).toHaveCount(4);

    await page.keyboard.press('Backspace');
    dots = page.locator('.pin-dot');
    await expect(dots).toHaveCount(3);
  });

  test('respects reduced motion preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const pinInput = page.locator('#test-basic');
    await pinInput.click();

    const cursor = page.locator('.pin-cursor');
    await expect(cursor).not.toHaveClass(/blinking/);
  });

  test('auto-focus works', async ({ page }) => {
    const pinInput = page.locator('#test-autofocus');
    await expect(pinInput).toBeFocused();
  });

  test('completion callback fires at correct length', async ({ page }) => {
    const pinInput = page.locator('#test-completion');
    await pinInput.click();
    await page.keyboard.type('1234');

    const statusMessage = page.locator('.status-message');
    await expect(statusMessage).toHaveText('PIN completed: 1234');
  });
});
