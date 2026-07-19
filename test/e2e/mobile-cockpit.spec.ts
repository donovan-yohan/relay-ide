import { expect, test, type Locator, type Page } from '@playwright/test';

const BLOCKED_ID = 'topic:cockpit-blocked';
const GENERAL_ID = 'topic:cockpit-general';
const WORKING_ID = 'topic:cockpit-working';
const WAITING_ID = 'topic:cockpit-waiting';
const RECONCILED_ID = 'topic:cockpit-reconciled';
const PENDING_ID = 'topic:cockpit-pending-inbox';
const IDLE_ID = 'topic:cockpit-idle';
const UNKNOWN_ID = 'topic:cockpit-unknown';
const CLAUDE_DM_ID = 'topic:dm~claude~workspace-cockpit-smoke';

async function openFixture(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/test-mobile-cockpit.html');
  await expect(page.locator('.topic-mobile-cockpit')).toBeVisible();
  await expect(page.locator('.topic-tree')).toBeHidden();
}

function attentionRow(page: Page, topicId: string): Locator {
  return page.locator(`.topic-cockpit__attention [data-topic-id="${topicId}"]`);
}

function anyCockpitRow(page: Page, topicId: string): Locator {
  return page
    .locator(`.topic-mobile-cockpit [data-topic-id="${topicId}"]`)
    .last();
}

function allChatsNode(page: Page, topicId: string): Locator {
  return page.locator('.topic-mobile-row-shell').filter({
    has: page.locator(`[data-topic-id="${topicId}"]`),
  });
}

interface PostedNudge {
  text?: string;
  format?: string;
  clientMessageId?: string;
}

test.describe('mobile mission-control cockpit (#1171)', () => {
  test('ranks blocked attention above unread and keeps the shared mobile tree', async ({
    page,
  }) => {
    await openFixture(page);

    const attentionRows = page.locator(
      '.topic-cockpit__attention [data-topic-id]'
    );
    await expect(attentionRow(page, BLOCKED_ID)).toBeVisible();
    await expect(attentionRow(page, GENERAL_ID)).toBeVisible();
    await expect(attentionRow(page, GENERAL_ID)).toHaveAttribute(
      'data-unread',
      'true'
    );
    await expect(attentionRows.first()).toHaveAttribute(
      'data-topic-id',
      BLOCKED_ID
    );
    await expect(
      page.locator(`.topic-mobile-list [data-topic-id="${GENERAL_ID}"]`)
    ).toBeVisible();
  });

  test('renders all presence states with DESIGN token colors and a working spinner', async ({
    page,
  }) => {
    await openFixture(page);

    const expected: Array<[string, string, string]> = [
      [WORKING_ID, 'working', 'rgb(251, 191, 36)'],
      [BLOCKED_ID, 'blocked', 'rgb(248, 113, 113)'],
      [GENERAL_ID, 'done', 'rgb(52, 211, 153)'],
      [IDLE_ID, 'idle', 'rgb(74, 222, 128)'],
      [UNKNOWN_ID, 'unknown', 'rgb(136, 136, 136)'],
    ];
    for (const [topicId, state, color] of expected) {
      const presence = anyCockpitRow(page, topicId).locator(
        `.cockpit-presence--${state}`
      );
      await expect(presence).toBeVisible();
      await expect(presence.locator('.cockpit-presence__dot')).toHaveCSS(
        state === 'idle' || state === 'unknown'
          ? 'border-color'
          : 'background-color',
        color
      );
    }
    await expect(
      anyCockpitRow(page, WORKING_ID).locator(
        '.cockpit-presence .topic-status__spinner'
      )
    ).toBeVisible();
    await expect(
      anyCockpitRow(page, WAITING_ID).locator('.cockpit-presence--blocked')
    ).toBeVisible();
    await expect(
      anyCockpitRow(page, WORKING_ID).locator('.topic-mobile-row__status')
    ).toHaveText('edit · TopicSidebarShell.tsx');
    await expect(page.locator('.agent-detail-card')).toHaveCount(0);
  });

  test('opens the approve form in default mode without diagnostics', async ({
    page,
  }) => {
    await openFixture(page);
    const blocked = attentionRow(page, BLOCKED_ID);
    await blocked.getByRole('button', { name: 'approve' }).click();

    const panel = page.locator('.topic-mobile-detail');
    await expect(panel).toBeVisible();
    const input = panel.locator('input[name="controlInput"]');
    await expect(input).toBeVisible();
    await input.focus();
    await expect(input).toBeFocused();
    await expect(panel.locator('.topic-mobile-detail__meta')).toHaveCount(0);
    await expect(panel.locator('.topic-mobile-actions')).toHaveCount(0);
  });

  test('interrupts a waiting agent without leaving the attention lane', async ({
    page,
  }) => {
    const interrupts: Array<{ method: string; url: string }> = [];
    await page.route('**/channels/*/agents/*/interrupt', async (route) => {
      interrupts.push({
        method: route.request().method(),
        url: route.request().url(),
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await openFixture(page);

    const waiting = attentionRow(page, WAITING_ID);
    await expect(waiting.locator('.cockpit-presence--blocked')).toBeVisible();
    await waiting
      .getByRole('button', { name: /interrupt.*waiting agent/i })
      .click();

    await expect.poll(() => interrupts.length).toBe(1);
    expect(interrupts[0]?.method).toBe('POST');
    expect(interrupts[0]?.url).toContain('cockpit-waiting');
    expect(interrupts[0]?.url).toContain('/agents/claude/interrupt');
    await expect(page.locator('.topic-cockpit__attention')).toBeVisible();
  });

  test('a newer unbound roster clears an older waiting socket signal', async ({
    page,
  }) => {
    await openFixture(page);

    await expect(attentionRow(page, RECONCILED_ID)).toHaveCount(0);
    const reconciled = anyCockpitRow(page, RECONCILED_ID);
    await expect(reconciled.locator('.cockpit-presence--idle')).toBeVisible();
    await expect(
      allChatsNode(page, RECONCILED_ID).getByRole('button', {
        name: /interrupt.*reconciled idle/i,
      })
    ).toHaveCount(0);
  });

  test('global roster pending inbox promotes an otherwise idle topic', async ({
    page,
  }) => {
    await openFixture(page);

    const pending = attentionRow(page, PENDING_ID);
    await expect(pending).toBeVisible();
    await expect(pending).toHaveAttribute('data-unread', 'false');
    await expect(pending).toContainText('pending inbox');
  });

  test('nudges from an ordinary all-chats row without opening the channel', async ({
    page,
  }) => {
    const posted: PostedNudge[] = [];
    await page.route('**/channels/*/messages', async (route) => {
      posted.push(route.request().postDataJSON() as PostedNudge);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: { id: 'msg:all-chats-nudge', channelId: IDLE_ID, seq: 1 },
        }),
      });
    });
    await openFixture(page);

    const idleNode = allChatsNode(page, IDLE_ID);
    await expect(attentionRow(page, IDLE_ID)).toHaveCount(0);
    await idleNode.getByRole('button', { name: /nudge.*seen idle/i }).click();
    const input = idleNode.locator('input[name="nudge"]');
    await expect(input).toBeFocused();
    await input.fill('status?');
    await input.press('Enter');

    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({ text: 'status?', format: 'text' });
    expect(posted[0]?.clientMessageId).toEqual(expect.any(String));
    await expect(page.locator('.topic-mobile-cockpit')).toBeVisible();
  });

  test('posts one idempotent DM nudge without closing the cockpit', async ({
    page,
  }) => {
    const posted: PostedNudge[] = [];
    await page.route('**/channels/*/messages', async (route) => {
      posted.push(route.request().postDataJSON() as PostedNudge);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: {
            id: 'msg:nudge-smoke',
            channelId: CLAUDE_DM_ID,
            seq: 6,
          },
        }),
      });
    });
    await openFixture(page);

    const dm = attentionRow(page, CLAUDE_DM_ID);
    await dm.getByRole('button', { name: 'nudge @Claude' }).click();
    const input = dm.locator('input[name="nudge"]');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('@claude ');
    await input.pressSequentially('ping');
    await input.press('Enter');

    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({
      text: '@claude ping',
      format: 'text',
    });
    expect(posted[0]).toEqual(
      expect.objectContaining({ clientMessageId: expect.any(String) })
    );
    await expect(page.locator('.topic-mobile-cockpit')).toBeVisible();
    await expect(page.locator('.topic-cockpit__attention')).toBeVisible();
  });

  test('retries an ambiguous nudge with the same idempotency key', async ({
    page,
  }) => {
    const attempts: PostedNudge[] = [];
    let accepted = 0;
    await page.route('**/channels/*/messages', async (route) => {
      attempts.push(route.request().postDataJSON() as PostedNudge);
      if (attempts.length === 1) {
        await route.abort('connectionreset');
        return;
      }
      accepted += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: { id: 'msg:nudge-retry', channelId: CLAUDE_DM_ID, seq: 6 },
        }),
      });
    });
    await openFixture(page);

    const dm = attentionRow(page, CLAUDE_DM_ID);
    await dm.getByRole('button', { name: 'nudge @Claude' }).click();
    const input = dm.locator('input[name="nudge"]');
    await input.pressSequentially('retry me');
    await input.press('Enter');
    await expect(dm.getByRole('status')).toContainText('failed:');
    await input.press('Enter');

    await expect.poll(() => attempts.length).toBe(2);
    await expect.poll(() => accepted).toBe(1);
    expect(attempts[0]?.clientMessageId).toEqual(attempts[1]?.clientMessageId);
    expect(attempts[0]?.clientMessageId).toEqual(expect.any(String));
    expect(attempts[1]).toMatchObject({
      text: '@claude retry me',
      format: 'text',
    });
    await expect(page.locator('.topic-mobile-cockpit')).toBeVisible();
  });
});
