import { test, expect } from '@playwright/test';

test.describe('CustomizeSessionDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-customize-session-dialog.html');
  });

  test('opens with environment picker and session options', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Customize Session' })
    ).toBeVisible();
    await expect(page.getByLabel('repo identity')).toBeVisible();
    await expect(page.getByLabel('execution node')).toBeVisible();
    await expect(page.getByLabel('node-local checkout')).toHaveCount(0);
    await expect(page.getByLabel('cwd on linux lab')).toBeVisible();
    await expect(page.getByLabel('coding agent')).toBeVisible();
    await expect(page.getByText('continue existing session')).toBeVisible();
    await expect(page.getByText('yolo mode')).toBeVisible();
    await expect(page.getByText('Launch in tmux')).toHaveCount(0);
  });

  test('local-repo lane keeps repo checkout payload unchanged', async ({
    page,
  }) => {
    await page.getByText('open single-node customize session').click();
    await page.getByRole('button', { name: 'Start Session' }).click();

    await expect(page.getByTestId('created-session')).toHaveText(
      'local-session'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '/sessions'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"repoPath":"/Users/kyle/relay-ide"'
    );
  });

  test('local web-capable default agents keep web session payloads', async ({
    page,
  }) => {
    await page.getByText('open local web-capable customize session').click();
    await expect(page.getByLabel('coding agent')).toHaveValue('hermes');
    await expect(page.getByLabel('interface')).toHaveValue('web');
    await page.getByRole('button', { name: 'Start Session' }).click();

    await expect(page.getByTestId('last-create-request')).toContainText(
      '/sessions'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"agent":"hermes"'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"mode":"web"'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"repoPath":"/Users/kyle/relay-ide"'
    );
  });

  test('remote-node lane uses free-text cwd and omits repo fields', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    await page.getByLabel('execution node').selectOption('linux');
    await expect(page.getByLabel('node-local checkout')).toHaveCount(0);
    await expect(page.getByLabel('cwd on linux lab')).toHaveValue(
      '/home/linux'
    );
    await page.getByLabel('cwd on linux lab').fill('/srv/manual-cwd');
    await page.getByRole('button', { name: 'Start Session' }).click();

    await expect(page.getByTestId('created-session')).toHaveText(
      'remote-session'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '/hub/nodes/linux/sessions'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"cwd":"/srv/manual-cwd"'
    );
    await expect(page.getByTestId('last-create-request')).not.toContainText(
      'repoPath'
    );
    await expect(page.getByTestId('last-create-request')).not.toContainText(
      'worktreePath'
    );
  });

  test('remote-node lane coerces web-capable default agents to pty payloads', async ({
    page,
  }) => {
    await page.getByText('open web-capable remote customize session').click();
    await page.getByLabel('execution node').selectOption('linux');
    await expect(page.getByLabel('coding agent')).toHaveValue('hermes');
    await expect(page.getByLabel('interface')).toHaveCount(0);
    await page.getByLabel('cwd on linux lab').fill('/srv/hermes-cwd');
    await page.getByRole('button', { name: 'Start Session' }).click();

    await expect(page.getByTestId('last-create-request')).toContainText(
      '/hub/nodes/linux/sessions'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"agent":"hermes"'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"mode":"pty"'
    );
    await expect(page.getByTestId('last-create-request')).not.toContainText(
      '"mode":"web"'
    );
    await expect(page.getByTestId('last-create-request')).not.toContainText(
      'repoPath'
    );
  });

  test('free remote lane starts in node home and remembers cwd per node', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    await page.getByLabel('execution node').selectOption('linux');
    await page.getByLabel('cwd on linux lab').fill('/opt/remember-me');
    await page.getByRole('button', { name: 'Start Session' }).click();
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"cwd":"/opt/remember-me"'
    );

    await page.getByText('open customize session').click();
    await page.getByLabel('execution node').selectOption('linux');
    await expect(page.getByLabel('cwd on linux lab')).toHaveValue(
      '/opt/remember-me'
    );
    await page.getByRole('button', { name: 'Start in Home' }).click();
    await expect(page.getByTestId('created-session')).toHaveText(
      'remote-home-session'
    );
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"cwd":"/home/linux"'
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
    await expect(
      nodeOptions.filter({ hasText: 'no claude box' })
    ).toBeDisabled();
    await expect(
      nodeOptions.filter({ hasText: 'no claude box' })
    ).toContainText('claude unavailable on no claude box');
    await expect(nodeOptions.filter({ hasText: 'no tmux box' })).toBeDisabled();
    await expect(nodeOptions.filter({ hasText: 'no tmux box' })).toContainText(
      'tmux unavailable on no tmux box'
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

  test('shows the disabled-node reason when the single-node picker is otherwise hidden', async ({
    page,
  }) => {
    await page.getByText('open single disabled-node customize session').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('repo identity')).toHaveCount(0);
    await expect(page.getByLabel('execution node')).toBeVisible();
    await expect(
      page.getByText('node is offline', { exact: true })
    ).toBeVisible();
    await expect(page.getByLabel('node-local checkout')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Start Session' })
    ).toBeDisabled();
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
