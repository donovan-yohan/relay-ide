import { expect, test, type Locator, type Page } from '@playwright/test';

async function openFixture(page: Page): Promise<void> {
  await page.goto('/test-sidebar-mechanics.html');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /engineering/i })
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
    await expect(page.locator('.sidebar')).toHaveScreenshot(
      'sidebar-default-no-mechanics.png',
      {
        animations: 'disabled',
        maxDiffPixels: 120,
        threshold: 0.2,
      }
    );
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
    const row = page.locator('.topic-row').filter({ hasText: 'engineering' });

    await page.getByTestId('emit-unread').click();
    await expect(row.getByLabel('unread activity')).toBeVisible();
    await row.getByRole('button', { name: /engineering/i }).click();

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

    const mobileChannel = page
      .locator('.topic-mobile-row')
      .filter({ hasText: 'engineering' });
    await expect(mobileChannel).toBeVisible();
    await mobileChannel.click();
    await expect(page.getByTestId('active-channel')).toHaveText(
      'topic:sidebar-smoke'
    );

    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'settings' });
    await enableAdvancedMode(dialog);
    await dialog.getByRole('button', { name: 'Close' }).click();

    await expect(page.locator('.topic-mobile-detail')).toBeVisible();
    await expect(page.locator('.topic-mobile-detail__meta')).toBeVisible();
    await expect(page.locator('.topic-mobile-control')).toBeVisible();
  });
});
