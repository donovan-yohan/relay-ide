import { test, expect } from '@playwright/test';

test.describe('CustomizeSessionDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-customize-session-dialog.html');
  });

  test('opens with agent select and checkboxes', async ({ page }) => {
    await page.getByText('Open Customize Session').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Customize Session')).toBeVisible();
    await expect(page.getByLabel('Coding agent')).toBeVisible();
    await expect(page.getByText('Continue existing session')).toBeVisible();
    await expect(page.getByText('Yolo mode')).toBeVisible();
    await expect(page.getByText('Launch in tmux')).toBeVisible();
  });

  test('has Start Session and Cancel buttons', async ({ page }) => {
    await page.getByText('Open Customize Session').click();
    await expect(
      page.getByRole('button', { name: 'Start Session' })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.getByText('Open Customize Session').click();
    await page.screenshot({
      path: 'test/e2e/screenshots/customize-session-dialog.png',
    });
  });
});
