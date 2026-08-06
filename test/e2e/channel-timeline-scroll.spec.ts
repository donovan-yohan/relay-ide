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

async function firstVisibleAnchor(
  timeline: Locator
): Promise<{ seq: string; top: number }> {
  return timeline.evaluate((element) => {
    const containerTop = element.getBoundingClientRect().top;
    const row = Array.from(
      element.querySelectorAll<HTMLElement>('[data-channel-message-seq]')
    ).find(
      (candidate) => candidate.getBoundingClientRect().bottom >= containerTop
    );
    if (!row) throw new Error('missing visible anchor row');
    return {
      seq: row.dataset.channelMessageSeq ?? '',
      top: row.getBoundingClientRect().top - containerTop,
    };
  });
}

test.describe('smoke channel timeline scroll UX (#1193)', () => {
  test('renders durable agent cards on the real channel host (#1198/#1206)', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    const thought = timeline.locator(
      '[data-channel-message-seq="68"] .ch-agent-card'
    );
    const output = timeline.locator(
      '[data-channel-message-seq="69"] .ch-agent-card'
    );
    const diff = timeline.locator(
      '[data-channel-message-seq="70"] .ch-agent-card'
    );

    await expect(thought).toHaveAttribute('data-agent-card-kind', 'thought');
    await expect(thought.locator('.ch-agent-card__body')).toHaveCount(0);
    const thoughtToggle = thought.locator('.ch-agent-card__toggle');
    await expect(thoughtToggle).toHaveAttribute('aria-expanded', 'false');
    await thoughtToggle.click();
    await expect(thoughtToggle).toHaveAttribute('aria-expanded', 'true');
    await thoughtToggle.press('Space');
    await expect(thoughtToggle).toHaveAttribute('aria-expanded', 'false');
    await thoughtToggle.focus();
    await thoughtToggle.press('Enter');
    await expect(thoughtToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(thought.locator('.ch-agent-card__body')).toContainText(
      'reasoning content persisted on the durable channel row'
    );

    await expect(output.locator('.ch-agent-card__toggle')).toContainText(
      '500 lines'
    );
    await expect(output.locator('.ch-agent-card__body')).toHaveCount(0);
    await output.locator('.ch-agent-card__toggle').click();
    const outputBody = output.locator('.ch-agent-card__body');
    await expect(outputBody).toBeVisible();
    await expect(
      output.locator('.ch-agent-card__line span[style*="color"]')
    ).not.toHaveCount(0);
    expect(
      await outputBody.evaluate(
        (element) => element.scrollHeight > element.clientHeight
      )
    ).toBe(true);

    await expect(diff.locator('.ch-agent-card__toggle')).toContainText(
      '+250 -250'
    );
    await diff.locator('.ch-agent-card__toggle').click();
    await expect(diff.locator('.ch-agent-card__line--added')).toHaveCount(250);
    await expect(diff.locator('.ch-agent-card__line--removed')).toHaveCount(
      250
    );
    const [addedTint, removedTint] = await Promise.all([
      diff
        .locator('.ch-agent-card__line--added')
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      diff
        .locator('.ch-agent-card__line--removed')
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ]);
    expect(addedTint).not.toBe('rgba(0, 0, 0, 0)');
    expect(removedTint).not.toBe('rgba(0, 0, 0, 0)');
    expect(addedTint).not.toBe(removedTint);
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
  });

  test('rerenders an authoritative full-row streaming card update', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    const row = timeline.locator('[data-channel-message-seq="67"]');
    await expect(row.locator('.ch-agent-card')).toHaveCount(0);
    await page.getByTestId('update-detail-row').click();

    const card = row.locator('.ch-agent-card');
    await expect(card).toHaveAttribute('data-agent-card-kind', 'thought');
    await expect(card.locator('.ch-agent-card__status')).toHaveText('running');
    await card.locator('.ch-agent-card__toggle').click();
    await expect(card.locator('.ch-agent-card__body')).toContainText(
      'authoritative debounced browser row'
    );
  });

  test('surfaces a missing-terminal truncation at the timeline last hop (#1188)', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    await page.getByTestId('append-truncated').click();

    const row = timeline.locator('[data-channel-message-seq="71"]');
    await expect(row).toHaveClass(/ch-msg--truncated/);
    await expect(row.locator('.ch-msg__tag--truncated')).toHaveText(
      'truncated · missing terminal'
    );
  });

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

  test('refreshes the prepend anchor when the reader scrolls during a delayed history load', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    await timeline.evaluate((element) => {
      element.scrollTop = 40;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(timeline.locator('.ch-loading-older')).toBeVisible();

    await timeline.evaluate((element) => {
      element.scrollTop = 70;
      element.dispatchEvent(new Event('scroll'));
    });
    const readerAnchor = await firstVisibleAnchor(timeline);

    await expect(
      timeline.locator('[data-channel-message-seq="1"]')
    ).toBeAttached();
    const restored = timeline.locator(
      `[data-channel-message-seq="${readerAnchor.seq}"]`
    );
    await expect
      .poll(async () => {
        const container = await timeline.boundingBox();
        const row = await restored.boundingBox();
        if (!container || !row) throw new Error('missing anchor geometry');
        return row.y - container.y;
      })
      .toBeCloseTo(readerAnchor.top, 0);
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
      backgroundColor: 'rgb(10, 10, 10)',
      borderRadius: '0px',
      borderStyle: 'solid',
    });
    await jump.click();
    await expect(jump).toBeHidden();
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
  });

  test('posting an own message cancels a pending prepend and returns to the present', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    await timeline.evaluate((element) => {
      element.scrollTop = 40;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(timeline.locator('.ch-loading-older')).toBeVisible();

    await page.getByTestId('append-own').click();
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
    await expect(page.locator('.ch-new-messages')).toHaveCount(0);

    // The delayed prepend settlement must not restore the cancelled anchor.
    await expect(
      timeline.locator('[data-channel-message-seq="1"]')
    ).toBeAttached();
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
    await expect(page.locator('.ch-new-messages')).toHaveCount(0);
  });

  test('keeps user markdown bubbles readable without mobile overflow', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    await page.getByTestId('append-own').click();

    const shortBubble = timeline.locator(
      '[data-channel-message-seq="71"].ch-msg--user .ch-msg__body'
    );
    await expect(shortBubble).toHaveText('did we open a PR?');
    const shortMetrics = await shortBubble.evaluate((bubble) => {
      const text = bubble.querySelector('p')?.firstChild;
      if (!text) throw new Error('missing markdown text node');
      const range = document.createRange();
      range.selectNodeContents(text);
      return {
        lines: range.getClientRects().length,
        bubbleWidth: bubble.getBoundingClientRect().width,
        rowWidth: bubble
          .closest<HTMLElement>('.ch-msg')!
          .getBoundingClientRect().width,
      };
    });
    // The phrase is short enough for one desktop line and the bubble now gets
    // its available width from the actual ChannelTimeline row, not min-content.
    expect(shortMetrics.lines).toBe(1);
    expect(shortMetrics.bubbleWidth).toBeGreaterThan(100);
    expect(shortMetrics.bubbleWidth).toBeLessThan(shortMetrics.rowWidth);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('append-own-long-token').click();
    const longBubble = timeline.locator(
      '[data-channel-message-seq="72"].ch-msg--user .ch-msg__body'
    );
    await expect(longBubble).toBeVisible();
    const mobileMetrics = await longBubble.evaluate((bubble) => {
      const row = bubble.closest<HTMLElement>('.ch-msg');
      if (!row) throw new Error('missing message row');
      const bubbleRect = bubble.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        scrollWidth: bubble.scrollWidth,
        clientWidth: bubble.clientWidth,
        bubbleLeft: bubbleRect.left,
        bubbleRight: bubbleRect.right,
        rowLeft: rowRect.left,
        rowRight: rowRect.right,
      };
    });
    expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(
      mobileMetrics.clientWidth
    );
    expect(mobileMetrics.bubbleLeft).toBeGreaterThanOrEqual(
      mobileMetrics.rowLeft
    );
    expect(mobileMetrics.bubbleRight).toBeLessThanOrEqual(
      mobileMetrics.rowRight
    );
  });

  test('full snapshots preserve a surviving row and fall back to the unread divider across a gap', async ({
    page,
  }) => {
    const timeline = await openFixture(page);
    await scrollAwayFromBottom(timeline);
    const overlapAnchor = await firstVisibleAnchor(timeline);

    await page.getByTestId('snapshot-overlap').click();
    await expect(
      timeline.locator(`[data-channel-message-seq="${overlapAnchor.seq}"]`)
    ).toBeAttached();
    await expect
      .poll(async () => {
        const container = await timeline.boundingBox();
        const row = await timeline
          .locator(`[data-channel-message-seq="${overlapAnchor.seq}"]`)
          .boundingBox();
        if (!container || !row) throw new Error('missing overlap geometry');
        return row.y - container.y;
      })
      .toBeCloseTo(overlapAnchor.top, 0);
    await expect(page.locator('.ch-new-messages')).toHaveCount(0);

    await page.getByTestId('snapshot-gap').click();
    const unreadDivider = timeline.locator('[data-channel-unread-divider]');
    await expect(unreadDivider).toBeVisible();
    await expect
      .poll(async () => {
        const container = await timeline.boundingBox();
        const divider = await unreadDivider.boundingBox();
        if (!container || !divider) throw new Error('missing divider geometry');
        return divider.y - container.y;
      })
      .toBeCloseTo(0, 0);
    await expect(page.locator('.ch-new-messages')).toHaveCount(0);
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
