import { expect, test, type Locator, type Page } from '@playwright/test';

async function openFixture(page: Page): Promise<void> {
  await page.goto('/test-sidebar-mechanics.html');
  await expect(page.locator('.sidebar')).toBeVisible();
  const rail =
    (page.viewportSize()?.width ?? 0) <= 600
      ? '.topic-mobile-list'
      : '.topic-tree';
  await expect(
    page.locator(`${rail} [data-topic-id="topic:sidebar-smoke"]`).first()
  ).toBeVisible();
}

async function enableAdvancedMode(dialog: Locator): Promise<void> {
  const setting = dialog
    .locator('#section-advanced .setting-row')
    .filter({ hasText: 'Advanced mode' })
    .first();
  const toggle = setting.locator('label.tui-checkbox');
  const input = toggle.locator('input[type="checkbox"]');
  await expect(input).not.toBeChecked();
  await toggle.click();
  await expect(input).toBeChecked();
}

interface RailGroupSnapshot {
  workspaceId: string;
  channels: string[];
  directMessages: string[];
}

async function readRailGroups(groups: Locator): Promise<RailGroupSnapshot[]> {
  const snapshots: RailGroupSnapshot[] = [];
  for (let index = 0; index < (await groups.count()); index += 1) {
    const group = groups.nth(index);
    const topicIds = async (section: string): Promise<string[]> =>
      group
        .locator(`[data-rail-section="${section}"]`)
        .first()
        .locator('[data-topic-id]')
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-topic-id') ?? '')
        );
    snapshots.push({
      workspaceId: (await group.getAttribute('data-workspace-id')) ?? '',
      channels: await topicIds('channels'),
      directMessages: await topicIds('direct-messages'),
    });
  }
  return snapshots;
}

async function expectMobileSidebarClosed(page: Page): Promise<void> {
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).not.toHaveClass(/\bopen\b/);
  await expect
    .poll(() =>
      sidebar.evaluate((element) => element.getBoundingClientRect().right)
    )
    .toBeLessThanOrEqual(0);
}

test.describe('smoke sidebar mechanics demotion (#1194)', () => {
  test('default rail keeps channels visible without task-room mechanics', async ({
    page,
  }) => {
    await openFixture(page);

    await expect(
      page.getByRole('region', { name: 'Relay workspace' })
    ).toBeVisible();
    await expect(page.locator('.topic-shell__advanced-detail')).toHaveCount(0);
    await expect(page.getByText('task room', { exact: true })).toHaveCount(0);
    await expect(page.getByText('raw terminal attach')).toHaveCount(0);
    const sidebar = page.locator('.sidebar');
    // `openFixture` waits for a lower rail row, which Playwright may reveal by
    // scrolling its nearest overflow ancestor. The visual contract is the
    // sidebar's canonical top position, where its header and footer stay in
    // frame, not that incidental wait-state scroll offset.
    await sidebar.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(sidebar).toHaveScreenshot('sidebar-default-no-mechanics.png', {
      animations: 'disabled',
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });

  test('existing Settings advanced toggle reveals the relocated mechanics', async ({
    page,
  }) => {
    await openFixture(page);
    await page.getByRole('button', { name: 'Settings' }).click();

    const dialog = page.getByRole('dialog', { name: 'settings' });
    await expect(dialog).toBeVisible();
    await enableAdvancedMode(dialog);
    await dialog.getByRole('button', { name: 'Close' }).click();

    await expect(page.locator('.topic-shell__advanced-detail')).toBeVisible();
    await expect(page.getByText('task room', { exact: true })).toBeVisible();
    await expect(page.getByText('raw terminal attach')).toBeVisible();

    await page.getByRole('button', { name: 'open evidence dashboard' }).click();
    await expect(page.getByTestId('evidence-route')).toHaveText(
      '/workspace/example:evidence'
    );
  });

  test('channel selection and unread activity remain functional', async ({
    page,
  }) => {
    await openFixture(page);
    const row = page
      .locator('.topic-tree [data-topic-id="topic:sidebar-smoke"]')
      .first();

    await page.getByTestId('emit-unread').click();
    await expect(row.getByLabel('unread activity')).toBeVisible();
    await row.locator(':scope > .topic-row > .topic-row__main').click();

    await expect(page.getByTestId('active-channel')).toHaveText(
      'topic:sidebar-smoke'
    );
    await expect(row.getByLabel('unread activity')).toHaveCount(0);
  });

  test('mobile keeps channels functional while mechanics remain advanced-only', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFixture(page);

    await expect(page.locator('.topic-mobile-detail')).toHaveCount(0);
    await expect(page.locator('.topic-mobile-detail__meta')).toHaveCount(0);
    await expect(page.locator('.topic-mobile-control')).toHaveCount(0);
    await expect(page.locator('.topic-shell__advanced-detail')).toHaveCount(0);
    await expect(page.getByText('raw terminal attach')).toHaveCount(0);

    const mobileChannel = page.locator(
      '.topic-mobile-row[data-topic-id="topic:sidebar-smoke"]'
    );
    await expect(mobileChannel).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'settings' });
    await enableAdvancedMode(dialog);
    await dialog.getByRole('button', { name: 'Close' }).click();

    await expect(page.locator('.topic-mobile-detail')).toBeVisible();
    await expect(page.locator('.topic-mobile-detail__meta')).toBeVisible();
    await expect(page.locator('.topic-mobile-control')).toBeVisible();

    await mobileChannel.click();
    await expectMobileSidebarClosed(page);
    await expect(page.getByTestId('channel-timeline')).toBeVisible();
    await expect(page.getByTestId('channel-timeline')).toHaveText(
      'channel timeline: topic:sidebar-smoke'
    );
  });
});

test.describe('sidebar desktop/mobile IA parity (#1205)', () => {
  test('shares workspace/channel/DM grouping, unread, and mobile navigation', async ({
    page,
  }) => {
    await openFixture(page);
    await page.getByTestId('emit-unread').click();

    const desktopGroups = page.locator('.topic-tree > .topic-workspace-group');
    const expectedGroups: RailGroupSnapshot[] = [
      {
        workspaceId: 'workspace:sidebar-smoke',
        channels: ['topic:sidebar-smoke', 'topic:sidebar-smoke-child'],
        directMessages: ['topic:dm~claude~workspace-sidebar-smoke'],
      },
      {
        workspaceId: 'workspace:sidebar-research',
        channels: ['topic:sidebar-research'],
        directMessages: ['topic:dm~codex~workspace-sidebar-research'],
      },
      {
        workspaceId: 'orphan',
        channels: ['topic:sidebar-orphan'],
        directMessages: ['topic:dm~hermes~workspace-sidebar-missing'],
      },
    ];
    await expect(desktopGroups).toHaveCount(3);
    const desktopRail = await readRailGroups(desktopGroups);
    expect(desktopRail).toEqual(expectedGroups);
    await expect(
      desktopGroups.nth(0).locator('[data-topic-id="topic:sidebar-smoke"]')
    ).toHaveAttribute('data-unread', 'true');
    await expect(
      desktopGroups
        .nth(1)
        .locator('[data-topic-id="topic:dm~codex~workspace-sidebar-research"]')
    ).toHaveAttribute('data-unread', 'true');

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileGroups = page.locator('.topic-mobile-group');
    await expect(mobileGroups).toHaveCount(3);
    const mobileRail = await readRailGroups(mobileGroups);
    expect(mobileRail).toEqual(expectedGroups);
    expect(mobileRail).toEqual(desktopRail);
    await expect(
      mobileGroups.nth(0).locator('[data-topic-id="topic:sidebar-smoke"]')
    ).toHaveAttribute('data-unread', 'true');
    await expect(
      mobileGroups
        .nth(1)
        .locator('[data-topic-id="topic:dm~codex~workspace-sidebar-research"]')
    ).toHaveAttribute('data-unread', 'true');

    const relayHeader = mobileGroups
      .nth(0)
      .locator('.topic-mobile-group__toggle');
    await expect(relayHeader).toHaveAttribute('aria-expanded', 'true');
    await relayHeader.click();
    await expect(relayHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(
      mobileGroups.nth(0).locator('[data-topic-id="topic:sidebar-smoke"]')
    ).toHaveCount(0);
    await expect(
      mobileGroups.nth(1).locator('[data-topic-id="topic:sidebar-research"]')
    ).toBeVisible();

    await relayHeader.click();
    await expect(relayHeader).toHaveAttribute('aria-expanded', 'true');
    await mobileGroups
      .nth(0)
      .locator('[data-topic-id="topic:sidebar-smoke"]')
      .click();
    await expectMobileSidebarClosed(page);
    await expect(page.getByTestId('channel-timeline')).toBeVisible();
    await expect(page.getByTestId('channel-timeline')).toHaveText(
      'channel timeline: topic:sidebar-smoke'
    );
  });
});
