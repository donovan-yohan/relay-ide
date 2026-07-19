import { expect, test, type Locator, type Page } from '@playwright/test';
import claudeFixture from '../fixtures/agent-detail/claude.js';
import codexFixture from '../fixtures/agent-detail/codex.js';
import hermesFixture from '../fixtures/agent-detail/hermes.js';

const fixtures = [claudeFixture, codexFixture, hermesFixture] as const;

async function openFixture(
  page: Page,
  provider: (typeof fixtures)[number]['provider'],
  layout: 'default' | 'card-near-bottom' = 'default'
): Promise<Locator> {
  await page.goto(
    `/test-agent-detail-rows.html?provider=${provider}&layout=${layout}`
  );
  await expect(
    page.locator(`[data-fixture-provider="${provider}"]`)
  ).toBeVisible();
  const timeline = page.getByRole('log', { name: 'agent detail timeline' });
  await expect(timeline).toBeVisible();
  await expect(timeline.locator('.ch-agent-card')).toHaveCount(3);
  return timeline;
}

function card(timeline: Locator, kind: 'thought' | 'output' | 'diff'): Locator {
  return timeline.locator(`.ch-agent-card[data-agent-card-kind="${kind}"]`);
}

async function bottomDistance(timeline: Locator): Promise<number> {
  return timeline.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight
  );
}

async function firstVisibleItem(
  timeline: Locator
): Promise<{ itemId: string; top: number }> {
  return timeline.evaluate((element) => {
    const containerTop = element.getBoundingClientRect().top;
    const item = Array.from(
      element.querySelectorAll<HTMLElement>('[data-agent-item-id]')
    ).find(
      (candidate) => candidate.getBoundingClientRect().bottom >= containerTop
    );
    if (!item?.dataset.agentItemId) {
      throw new Error('missing first-visible agent item');
    }
    return {
      itemId: item.dataset.agentItemId,
      top: item.getBoundingClientRect().top - containerTop,
    };
  });
}

for (const fixture of fixtures) {
  test.describe(`smoke ${fixture.provider} agent detail rows (#1198)`, () => {
    test('thought content starts collapsed and toggles without an empty row', async ({
      page,
    }) => {
      const timeline = await openFixture(page, fixture.provider);
      const thought = card(timeline, 'thought');
      const toggle = thought.locator('.ch-agent-card__toggle');

      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(thought.locator('.ch-agent-card__body')).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(thought.locator('.ch-agent-card__body')).toContainText(
        fixture.assertions.thoughtContent
      );

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(thought.locator('.ch-agent-card__body')).toHaveCount(0);
    });

    test('500 changed lines stay one-line collapsed and expand inside a bounded scroller', async ({
      page,
    }) => {
      const timeline = await openFixture(page, fixture.provider);
      const diff = card(timeline, 'diff');
      const toggle = diff.locator('.ch-agent-card__toggle');
      const collapsedHeight = await diff.evaluate(
        (element) => element.getBoundingClientRect().height
      );

      expect(collapsedHeight).toBeLessThanOrEqual(40);
      await expect(toggle).toContainText('+250 -250');
      await expect(toggle).toContainText(fixture.assertions.diffPath);
      await toggle.click();

      const body = diff.locator('.ch-agent-card__body');
      await expect(body).toBeVisible();
      await expect(
        body.locator(
          '.ch-agent-card__line--added, .ch-agent-card__line--removed'
        )
      ).toHaveCount(fixture.assertions.changedLineCount);
      const geometry = await body.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          overflowY: style.overflowY,
        };
      });
      expect(geometry.clientHeight).toBeLessThan(geometry.scrollHeight);
      expect(['auto', 'scroll']).toContain(geometry.overflowY);

      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() => body.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    });

    test('diff tints and lazy syntax tokens are visible after expansion', async ({
      page,
    }) => {
      const timeline = await openFixture(page, fixture.provider);
      const diff = card(timeline, 'diff');
      await diff.locator('.ch-agent-card__toggle').click();

      const added = diff.locator('.ch-agent-card__line--added').first();
      const removed = diff.locator('.ch-agent-card__line--removed').first();
      await expect(added).toBeVisible();
      await expect(removed).toBeVisible();
      const [addedTint, removedTint] = await Promise.all([
        added.evaluate((element) => getComputedStyle(element).backgroundColor),
        removed.evaluate(
          (element) => getComputedStyle(element).backgroundColor
        ),
      ]);
      expect(addedTint).not.toBe('rgba(0, 0, 0, 0)');
      expect(removedTint).not.toBe('rgba(0, 0, 0, 0)');
      expect(addedTint).not.toBe(removedTint);

      const output = card(timeline, 'output');
      await output.locator('.ch-agent-card__toggle').click();
      await expect
        .poll(() =>
          output.locator('.ch-agent-card__line span[style*="color"]').count()
        )
        .toBeGreaterThan(0);
    });

    test('expanding a card above the reader preserves the first-visible item anchor', async ({
      page,
    }) => {
      const timeline = await openFixture(page, fixture.provider);
      const requestedAnchor = timeline.locator(
        `[data-agent-item-id="${fixture.provider}-anchor-20"]`
      );
      await requestedAnchor.scrollIntoViewIfNeeded();
      await timeline.evaluate((element) => {
        element.dispatchEvent(new Event('scroll'));
      });
      await expect.poll(() => bottomDistance(timeline)).toBeGreaterThan(100);
      const anchor = await firstVisibleItem(timeline);

      // A Playwright click would scroll the off-screen card into view first,
      // masking the production reflow behavior. Dispatch a DOM click so only
      // the card expansion changes geometry.
      await card(timeline, 'diff')
        .locator('.ch-agent-card__toggle')
        .evaluate((element) => (element as HTMLButtonElement).click());
      await expect(
        card(timeline, 'diff').locator('.ch-agent-card__body')
      ).toBeAttached();

      const anchoredItem = timeline.locator(
        `[data-agent-item-id="${anchor.itemId}"]`
      );
      await expect
        .poll(async () => {
          const containerBox = await timeline.boundingBox();
          const itemBox = await anchoredItem.boundingBox();
          if (!containerBox || !itemBox) {
            throw new Error('missing anchor geometry');
          }
          return itemBox.y - containerBox.y;
        })
        .toBeCloseTo(anchor.top, 0);
      await expect.poll(() => bottomDistance(timeline)).toBeGreaterThan(100);
    });
  });
}

test.describe('smoke agent detail timeline identity (#1198)', () => {
  test('switching equal-length sessions resets follow intent to the newest row', async ({
    page,
  }) => {
    const timeline = await openFixture(page, 'claude');
    await timeline
      .locator('[data-agent-item-id="claude-anchor-12"]')
      .scrollIntoViewIfNeeded();
    await timeline.evaluate((element) => {
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => bottomDistance(timeline)).toBeGreaterThan(100);

    await page.getByRole('button', { name: 'show hermes fixture' }).click();
    await expect(
      page.locator('[data-fixture-provider="hermes"]')
    ).toBeVisible();
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
    await expect(
      timeline.locator('[data-agent-item-id="hermes-anchor-48"]')
    ).toBeAttached();
    await expect(
      timeline.locator('[data-agent-item-id="claude-anchor-12"]')
    ).toHaveCount(0);
  });

  test('a near-bottom card toggle stays anchored and exposes jump-to-latest', async ({
    page,
  }) => {
    const timeline = await openFixture(page, 'codex', 'card-near-bottom');
    const diff = card(timeline, 'diff');
    const toggle = diff.locator('.ch-agent-card__toggle');
    await expect(toggle).toBeInViewport();
    const before = await toggle.boundingBox();
    if (!before) throw new Error('missing card toggle geometry');

    await toggle.click();

    await expect(diff.locator('.ch-agent-card__body')).toBeVisible();
    const after = await toggle.boundingBox();
    if (!after) throw new Error('missing expanded card toggle geometry');
    expect(after.y).toBeCloseTo(before.y, 0);
    await expect(
      page.getByRole('button', { name: 'jump to latest' })
    ).toBeVisible();
    await expect.poll(() => bottomDistance(timeline)).toBeGreaterThan(1);

    await page.getByRole('button', { name: 'jump to latest' }).click();
    await expect.poll(() => bottomDistance(timeline)).toBeLessThanOrEqual(1);
  });

  test('mobile keeps diff magnitude visible in the collapsed summary', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 720 });
    const timeline = await openFixture(page, 'claude');
    await expect(
      card(timeline, 'diff').locator('.ch-agent-card__size')
    ).toBeVisible();
    await expect(
      card(timeline, 'diff').locator('.ch-agent-card__size')
    ).toHaveText('+250 -250');
  });
});
