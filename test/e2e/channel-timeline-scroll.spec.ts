import { expect, test, type Locator, type Page } from '@playwright/test';

async function openFixture(page: Page): Promise<Locator> {
  await page.goto('/test-channel-timeline.html');
  const timeline = page.getByRole('log', { name: 'channel timeline' });
  await expect(timeline).toBeVisible();
  await expect(timeline.locator('[data-channel-message-seq]')).toHaveCount(50);
  return timeline;
}

async function bottomDistance(timeline: Locator): Promise<number> {
  return timeline.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight
  );
}

async function scrollAwayFromBottom(timeline: Locator): Promise<number> {
  return timeline.evaluate((element) => {
    element.scrollTop = Math.max(
      100,
      element.scrollHeight - element.clientHeight - 500
    );
    element.dispatchEvent(new Event('scroll'));
    return element.scrollTop;
  });
}

test.describe('channel timeline scroll UX (#1193)', () => {
  test('opens at the newest message', async ({ page }) => {
    const timeline = await openFixture(page);
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
  });

  test('follows oversized appends and streaming growth from the bottom', async ({
    page,
  }) => {
    const timeline = await openFixture(page);

    await page.getByTestId('append-large').click();
    await expect(timeline.locator('[data-channel-message-seq]')).toHaveCount(
      51
    );
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);

    await page.getByTestId('grow-stream').click();
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
  });

  test('does not hijack a reader for catch-up bursts or stream growth', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    const before = await scrollAwayFromBottom(timeline);

    await page.getByTestId('append-burst').click();
    await expect(
      page.getByRole('button', { name: '3 new messages' })
    ).toBeVisible();
    await expect
      .poll(() => timeline.evaluate((element) => element.scrollTop))
      .toBe(before);

    await page.getByTestId('grow-stream').click();
    await expect
      .poll(() => timeline.evaluate((element) => element.scrollTop))
      .toBe(before);
    await expect(
      page.getByRole('button', { name: '3 new messages' })
    ).toBeVisible();
  });

  test('new-message affordance jumps to present and clears', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    await scrollAwayFromBottom(timeline);
    await page.getByTestId('append-one').click();

    const jump = page.getByRole('button', { name: '1 new message' });
    await expect(jump).toBeVisible();
    const style = await jump.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        backgroundColor: computed.backgroundColor,
        borderRadius: computed.borderRadius,
        borderStyle: computed.borderStyle,
      };
    });
    expect(style).toEqual({
      backgroundColor: 'rgba(0, 0, 0, 0)',
      borderRadius: '0px',
      borderStyle: 'solid',
    });
    await jump.click();
    await expect(jump).toBeHidden();
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
  });

  test('preserves the visible row across prepend plus concurrent catch-up and keeps the unread divider', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    await expect(
      page.getByRole('separator', { name: 'new messages' })
    ).toHaveCount(1);
    const dividerBeforeFirstUnread = await timeline.evaluate((element) => {
      const divider = element.querySelector('[aria-label="new messages"]');
      const firstUnread = element.querySelector(
        '[data-channel-message-seq="56"]'
      );
      return Boolean(
        divider &&
        firstUnread &&
        divider.compareDocumentPosition(firstUnread) &
          Node.DOCUMENT_POSITION_FOLLOWING
      );
    });
    expect(dividerBeforeFirstUnread).toBe(true);

    const anchor = await timeline.evaluate((element) => {
      element.scrollTop = 40;
      const containerTop = element.getBoundingClientRect().top;
      const row = Array.from(
        element.querySelectorAll<HTMLElement>('[data-channel-message-seq]')
      ).find(
        (candidate) => candidate.getBoundingClientRect().bottom >= containerTop
      );
      if (!row) throw new Error('missing visible anchor row');
      const result = {
        seq: row.dataset.channelMessageSeq ?? '',
        top: row.getBoundingClientRect().top - containerTop,
      };
      element.dispatchEvent(new Event('scroll'));
      return result;
    });

    await expect(
      timeline.locator('[data-channel-message-seq="1"]')
    ).toBeAttached();
    const restoredTop = await timeline
      .locator(`[data-channel-message-seq="${anchor.seq}"]`)
      .evaluate(
        (row, timelineElement) =>
          row.getBoundingClientRect().top -
          (timelineElement as HTMLElement).getBoundingClientRect().top,
        await timeline.elementHandle()
      );
    expect(restoredTop).toBeCloseTo(anchor.top, 0);
    await expect(
      page.getByRole('button', { name: '1 new message' })
    ).toBeVisible();
  });

  test('keeps the bottom anchored across mobile viewport and keyboard-sized resizes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const timeline = await openFixture(page);
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 520 });
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
  });
});
