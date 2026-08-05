import { test, expect } from '@playwright/test';

test.describe('CustomizeSessionDialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-customize-session-dialog.html');
  });

  test('opens in chat mode without terminal environment controls', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Customize Session' })
    ).toBeVisible();
    await expect(page.getByLabel('repo identity')).toHaveCount(0);
    await expect(page.getByLabel('execution node')).toHaveCount(0);
    await expect(page.getByLabel('node-local checkout')).toHaveCount(0);
    await expect(page.getByLabel('cwd on linux lab')).toHaveCount(0);
    await expect(page.getByLabel('agent', { exact: true })).toBeVisible();
    await expect(page.getByLabel('interface')).toHaveCount(0);
    await expect(page.getByText('Launch in tmux')).toHaveCount(0);
  });

  test('local-repo lane keeps repo checkout payload unchanged', async ({
    page,
  }) => {
    await page.getByText('open single-node customize session').click();
    await page.getByLabel('mode').selectOption('terminal');
    await page.getByRole('button', { name: 'Start Terminal' }).click();

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

  test('local agents open a DM channel without creating a session', async ({
    page,
  }) => {
    await page.getByText('open local web-capable customize session').click();
    await expect(page.getByLabel('agent', { exact: true })).toHaveValue('hermes');
    await expect(page.getByLabel('interface')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Chat' }).click();
    await expect(page.getByTestId('active-channel')).toContainText('hermes');
    await expect(page.getByTestId('last-create-request')).toHaveText('');
  });

  test('remote-node lane uses free-text cwd and omits repo fields', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    await page.getByLabel('mode').selectOption('terminal');
    await page.getByLabel('execution node').selectOption('linux');
    await expect(page.getByLabel('node-local checkout')).toHaveCount(0);
    await expect(page.getByLabel('cwd on linux lab')).toHaveValue(
      '/home/linux'
    );
    await page.getByLabel('cwd on linux lab').fill('/srv/manual-cwd');
    await page.getByRole('button', { name: 'Start Terminal' }).click();

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

  test('remote agent selection still opens a DM channel', async ({ page }) => {
    await page.getByText('open web-capable remote customize session').click();
    await expect(page.getByLabel('execution node')).toHaveCount(0);
    await expect(page.getByLabel('agent', { exact: true })).toHaveValue('hermes');
    await expect(page.getByLabel('interface')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Chat' }).click();
    await expect(page.getByTestId('active-channel')).toContainText('hermes');
    await expect(page.getByTestId('last-create-request')).toHaveText('');
  });

  test('free remote lane starts in node home and remembers cwd per node', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    await page.getByLabel('mode').selectOption('terminal');
    await page.getByLabel('execution node').selectOption('linux');
    await page.getByLabel('cwd on linux lab').fill('/opt/remember-me');
    await page.getByRole('button', { name: 'Start Terminal' }).click();
    await expect(page.getByTestId('last-create-request')).toContainText(
      '"cwd":"/opt/remember-me"'
    );

    await page.getByText('open customize session').click();
    await page.getByLabel('mode').selectOption('terminal');
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

  // #1299: this test asserted two rules the product dropped — that a node
  // without the agent installed is unlaunchable, and that a node without
  // `tmux-compat` is too. `nodeShellBlockReason` blocks on reachability and
  // shell/`relay-pty` capability only, and `tmux-compat` is unsupported legacy
  // that must not come back. It now pins the rule that exists.
  test('disables unreachable nodes and leaves capability-complete ones launchable', async ({
    page,
  }) => {
    await page.getByText('open customize session').click();
    await page.getByLabel('mode').selectOption('terminal');
    const nodeOptions = page.locator('#cs-node option');

    await expect(nodeOptions.filter({ hasText: 'offline lab' })).toBeDisabled();
    await expect(nodeOptions.filter({ hasText: 'offline lab' })).toContainText(
      'node is offline'
    );
    // Chat and terminal launches no longer require the agent binary on the
    // node, so a missing framework is not a block.
    await expect(
      nodeOptions.filter({ hasText: 'no claude box' })
    ).toBeEnabled();
    // relay-pty is the only supported backend; having it is enough.
    await expect(nodeOptions.filter({ hasText: 'no tmux box' })).toBeEnabled();
  });

  test('keeps the single-node local path low-friction', async ({ page }) => {
    await page.getByText('open single-node customize session').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('repo identity')).toHaveCount(0);
    await expect(page.getByLabel('execution node')).toHaveCount(0);
    await expect(page.getByLabel('node-local checkout')).toHaveCount(0);
    await expect(page.getByLabel('agent', { exact: true })).toBeVisible();
  });

  test('does not block chat on terminal-node availability', async ({
    page,
  }) => {
    await page.getByText('open single disabled-node customize session').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('repo identity')).toHaveCount(0);
    await expect(page.getByLabel('execution node')).toHaveCount(0);
    await expect(
      page.getByText('node is offline', { exact: true })
    ).toHaveCount(0);
    await expect(page.getByLabel('node-local checkout')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open Chat' })).toBeEnabled();
  });

  test('has Open Chat and Cancel buttons', async ({ page }) => {
    await page.getByText('open customize session').click();
    await expect(page.getByRole('button', { name: 'Open Chat' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('screenshot', async ({ page }) => {
    await page.getByText('open customize session').click();
    await page.screenshot({
      path: 'test/e2e/screenshots/customize-session-dialog.png',
    });
  });
});
