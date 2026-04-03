import { test, expect } from '@playwright/test';

test.describe('WorkspaceEditor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-workspace-editor.html');
  });

  test('renders git settings section', async ({ page }) => {
    await expect(page.getByText('git settings')).toBeVisible();
    await expect(page.getByLabel('Branch new worktrees from')).toBeVisible();
    await expect(page.getByLabel('Remote origin')).toBeVisible();
    await expect(page.getByLabel('Branch prefix')).toBeVisible();
  });

  test('renders session defaults section', async ({ page }) => {
    await expect(page.getByText('session defaults').first()).toBeVisible();
    await expect(page.getByLabel('Default agent')).toBeVisible();
    await expect(page.getByText('Continue')).toBeVisible();
    await expect(page.getByText('YOLO')).toBeVisible();
    await expect(page.getByText('Tmux')).toBeVisible();
  });

  test('shows override badge when overridden', async ({ page }) => {
    await expect(page.getByText('overridden')).toBeVisible();
  });

  test('shows error when provided', async ({ page }) => {
    await expect(page.getByText('Failed to load settings.')).toBeVisible();
  });

  test('renders prompt toggles', async ({ page }) => {
    await expect(page.getByText('Code review preferences')).toBeVisible();
    await expect(page.getByText('Create PR preferences')).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.screenshot({ path: 'tests/screenshots/workspace-editor.png' });
  });
});
