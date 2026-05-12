import { test, expect } from '@playwright/test';

test.describe('CustomizeSessionDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-customize-session-dialog.html');
  });

  test('opens with environment picker and session options', async ({ page }) => {
    await page.getByText('open customize session').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Customize Session' })).toBeVisible();
    await expect(page.getByLabel('repo identity')).toBeVisible();
    await expect(page.getByLabel('execution node')).toBeVisible();
    await expect(page.getByLabel('node-local checkout')).toBeVisible();
    await expect(page.getByLabel('coding agent')).toBeVisible();
    await expect(page.getByText('continue existing session')).toBeVisible();
    await expect(page.getByText('yolo mode')).toBeVisible();
    await expect(page.getByText('Launch in tmux')).toHaveCount(0);
  });

  test('routes a multi-node checkout launch through the selected node', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    await page.getByLabel('execution node').selectOption('linux');
    await page
      .getByLabel('node-local checkout')
      .selectOption('worktree:linux:%2Fsrv%2Frelay-ide%2F.worktrees%2Ffeature');
    await page.getByRole('button', { name: 'Start Session' }).click();

    await expect(page.getByTestId('created-session')).toHaveText(
      'remote-session'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '/hub/nodes/linux/sessions'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"repoPath":"/srv/relay-ide"'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"worktreePath":"/srv/relay-ide/.worktrees/feature"'
    );
  });

  test('shows disabled reasons for offline and capability-blocked nodes', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    const nodeOptions = page.locator('#cs-node option');

    await expect(nodeOptions.filter({ hasText: 'offline lab' })).toBeDisabled();
    await expect(nodeOptions.filter({ hasText: 'offline lab' })).toContainText(
      'node is offline'
    );
    await expect(nodeOptions.filter({ hasText: 'no claude box' })).toBeDisabled();
    await expect(nodeOptions.filter({ hasText: 'no claude box' })).toContainText(
      'claude unavailable on no claude box'
    );
  });

  test('keeps the single-node local path low-friction', async ({ page }) => {
    await page.getByText('open single-node customize session').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('repo identity')).toHaveCount(0);
    await expect(page.getByLabel('execution node')).toHaveCount(0);
    await expect(page.getByLabel('node-local checkout')).toHaveCount(0);
    await expect(page.getByLabel('coding agent')).toBeVisible();
  });

  test('has Start Session and Cancel buttons', async ({ page }) => {
    await page.getByText('open customize session').click();
    await expect(
      page.getByRole('button', { name: 'Start Session' })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.getByText('open customize session').click();
    await page.screenshot({
      path: 'test/e2e/screenshots/customize-session-dialog.png',
    });
  });
});
