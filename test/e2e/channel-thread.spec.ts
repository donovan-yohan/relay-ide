import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

const PIN = '1170-thread-ui';
const CAPS = {
  read: { 'x-relay-capabilities': 'context:read' },
  write: {
    'Content-Type': 'application/json',
    'x-relay-capabilities': 'context:write',
  },
};

interface PostedMessage {
  id: string;
  seq: number;
  threadId: string | null;
  body: { text: string };
}

let fixtureOrdinal = 0;

async function authenticate(context: BrowserContext): Promise<void> {
  const request = context.request;
  const status = await request.get('/auth/status');
  expect(status.ok()).toBe(true);
  const { hasPIN } = (await status.json()) as { hasPIN: boolean };
  const auth = hasPIN
    ? await request.post('/auth', { data: { pin: PIN } })
    : await request.post('/auth/setup', {
        data: { pin: PIN, confirm: PIN },
      });
  expect(auth.ok()).toBe(true);
}

async function createChannel(context: BrowserContext): Promise<string> {
  fixtureOrdinal += 1;
  const id = `topic:e2e-thread-${Date.now()}-${fixtureOrdinal}`;
  const response = await context.request.post('/workspace-topics', {
    headers: CAPS.write,
    data: {
      id,
      workspaceId: 'ws-e2e-thread',
      title: `thread-e2e-${fixtureOrdinal}`,
    },
  });
  expect(response.status()).toBe(201);
  return id;
}

async function postMessage(
  request: APIRequestContext,
  channelId: string,
  text: string,
  threadId?: string
): Promise<PostedMessage> {
  const response = await request.post(
    `/channels/${encodeURIComponent(channelId)}/messages`,
    {
      headers: CAPS.write,
      data: {
        text,
        clientMessageId: `e2e-${Date.now()}-${Math.random()}`,
        ...(threadId ? { threadId } : {}),
      },
    }
  );
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { message: PostedMessage };
  return body.message;
}

async function seedThread(
  context: BrowserContext,
  replyCount: number
): Promise<{ channelId: string; root: PostedMessage }> {
  await authenticate(context);
  const channelId = await createChannel(context);
  const root = await postMessage(
    context.request,
    channelId,
    'load-bearing thread root'
  );
  for (let index = 1; index <= replyCount; index += 1) {
    await postMessage(
      context.request,
      channelId,
      `seeded thread reply ${String(index).padStart(3, '0')}`,
      root.id
    );
  }
  return { channelId, root };
}

async function openChannel(
  page: Page,
  input: { channelId: string; threadRootId?: string }
): Promise<void> {
  const params = new URLSearchParams({ channelId: input.channelId });
  if (input.threadRootId) params.set('threadRootId', input.threadRootId);
  await page.goto(`/test-channel-thread.html?${params}`);
  await expect(page.getByRole('main', { name: 'channel' })).toBeVisible();
  await expect(page.getByLabel(/connected|reconnecting/)).toHaveAttribute(
    'aria-label',
    'connected'
  );
}

async function captureFirstVisible(
  log: Locator
): Promise<{ seq: string; top: number }> {
  return log.evaluate((element) => {
    const containerTop = element.getBoundingClientRect().top;
    const row = Array.from(
      element.querySelectorAll<HTMLElement>('[data-channel-message-seq]')
    ).find(
      (candidate) => candidate.getBoundingClientRect().bottom >= containerTop
    );
    if (!row) throw new Error('missing visible message row');
    return {
      seq: row.dataset.channelMessageSeq ?? '',
      top: row.getBoundingClientRect().top - containerTop,
    };
  });
}

async function expectAnchorStable(
  log: Locator,
  anchor: { seq: string; top: number }
): Promise<void> {
  const row = log.locator(`[data-channel-message-seq="${anchor.seq}"]`);
  await expect
    .poll(async () => {
      const containerBox = await log.boundingBox();
      const rowBox = await row.boundingBox();
      if (!containerBox || !rowBox) throw new Error('missing anchor geometry');
      return rowBox.y - containerBox.y;
    })
    .toBeCloseTo(anchor.top, 0);
}

test.describe.serial('smoke channel thread UI (#1170)', () => {
  test('opens the panel from the reply chip with a pinned root and thread composer', async ({
    context,
    page,
  }) => {
    const { channelId } = await seedThread(context, 2);
    await openChannel(page, { channelId });

    const chip = page.getByRole('button', {
      name: '2 replies — open thread',
    });
    await expect(chip).toBeVisible();
    await chip.click();

    const panel = page.locator('.ch-thread');
    await expect(panel).toBeVisible();
    await expect(
      panel.locator('.ch-thread__root').getByText('load-bearing thread root')
    ).toBeVisible();
    await expect(
      panel.getByRole('textbox', { name: 'message input' })
    ).toHaveAttribute('placeholder', /reply in thread/i);
  });

  test('posts a reply into the panel, not the main lane, and increments the chip', async ({
    context,
    page,
  }) => {
    const { channelId } = await seedThread(context, 1);
    await openChannel(page, { channelId });
    await page.getByRole('button', { name: '1 reply — open thread' }).click();

    const panel = page.locator('.ch-thread');
    const mainTimeline = page.locator('.ch-tl');
    const input = panel.getByRole('textbox', { name: 'message input' });
    await input.fill('reply posted from the thread composer');
    await input.press('Enter');

    await expect(
      panel
        .locator('.ch-thread__scroll')
        .getByText('reply posted from the thread composer')
    ).toBeVisible();
    await expect(
      mainTimeline.getByText('reply posted from the thread composer')
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '2 replies — open thread' })
    ).toBeVisible();
    await expect(panel.locator('.ch-thread__header')).toContainText(
      '2 replies'
    );
  });

  test('updates chip and panel header live after a second REST sender posts', async ({
    context,
    page,
  }) => {
    const { channelId, root } = await seedThread(context, 1);
    await openChannel(page, { channelId });
    await page.getByRole('button', { name: '1 reply — open thread' }).click();

    await postMessage(
      context.request,
      channelId,
      'live reply from another sender',
      root.id
    );

    await expect(
      page.getByRole('button', { name: '2 replies — open thread' })
    ).toBeVisible();
    const panel = page.locator('.ch-thread');
    await expect(panel.locator('.ch-thread__header')).toContainText(
      '2 replies'
    );
    await expect(
      panel
        .locator('.ch-thread__scroll')
        .getByText('live reply from another sender')
    ).toBeVisible();
    await expect(
      page.locator('.ch-tl').getByText('live reply from another sender')
    ).toHaveCount(0);
  });

  test('walks a thread beyond one page without moving the visible reply or the pinned root', async ({
    context,
    page,
  }) => {
    const { channelId, root } = await seedThread(context, 210);
    const olderRequests: string[] = [];
    const channelHistoryRequests: string[] = [];
    let failedFirstChannelBackfill = false;
    await page.route('**/channels/**/messages?**', async (route) => {
      const url = route.request().url();
      if (
        route.request().method() === 'GET' &&
        url.includes(`/channels/${encodeURIComponent(channelId)}/messages`) &&
        url.includes('beforeSeq=')
      ) {
        channelHistoryRequests.push(url);
        if (!failedFirstChannelBackfill) {
          failedFirstChannelBackfill = true;
          await route.abort('failed');
          return;
        }
      }
      await route.continue();
    });
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        request.url().includes(`/threads/${encodeURIComponent(root.id)}`) &&
        request.url().includes('beforeSeq=')
      ) {
        olderRequests.push(request.url());
      }
    });
    // Normal channel open intentionally starts on a reply-only 100-row socket
    // snapshot. The view must retry one transient failure, then walk multiple
    // pages non-geometrically until the root/top-level lane is reachable.
    await openChannel(page, { channelId });
    await expect(page.getByText('load-bearing thread root')).toBeVisible();
    // One same-cursor failure + three successful distinct cursor pages reaches
    // this 210-reply root. The failed retry does not spend another page slot.
    await expect.poll(() => channelHistoryRequests.length).toBe(4);
    await page.waitForTimeout(500);
    expect(channelHistoryRequests).toHaveLength(4);
    const rootChip = page.getByRole('button', {
      name: '210 replies — open thread',
    });
    await expect(rootChip).toBeVisible();
    await expect(
      page.locator('.ch-tl').getByText(/seeded thread reply/)
    ).toHaveCount(0);
    await rootChip.click();

    const panel = page.locator('.ch-thread');
    const scroll = panel.locator('.ch-thread__scroll');
    await expect(scroll).toBeVisible();
    await expect(scroll.getByText('seeded thread reply 210')).toBeVisible();

    const anchor = await scroll.evaluate((element) => {
      element.scrollTop = 0;
      const containerTop = element.getBoundingClientRect().top;
      const row = Array.from(
        element.querySelectorAll<HTMLElement>('[data-channel-message-seq]')
      ).find(
        (candidate) => candidate.getBoundingClientRect().bottom >= containerTop
      );
      if (!row) throw new Error('missing visible thread anchor row');
      const result = {
        seq: row.dataset.channelMessageSeq ?? '',
        top: row.getBoundingClientRect().top - containerTop,
      };
      element.dispatchEvent(new Event('scroll'));
      return result;
    });
    const anchorRow = scroll.locator(
      `[data-channel-message-seq="${anchor.seq}"]`
    );
    await expect.poll(() => olderRequests.length).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const container = await scroll.boundingBox();
        const row = await anchorRow.boundingBox();
        if (!container || !row)
          throw new Error('missing thread anchor geometry');
        return row.y - container.y;
      })
      .toBeCloseTo(anchor.top, 0);

    // The thread-history lane itself still walks backward in 50-row pages and
    // keeps its visible row stable while prepending.
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => olderRequests.length).toBeGreaterThan(1);

    await expect(
      panel.locator('.ch-thread__root').getByText('load-bearing thread root')
    ).toBeVisible();
    const rootBox = await panel.locator('.ch-thread__root').boundingBox();
    const scrollBox = await scroll.boundingBox();
    expect(rootBox).not.toBeNull();
    expect(scrollBox).not.toBeNull();
    expect(rootBox!.y + rootBox!.height).toBeLessThanOrEqual(scrollBox!.y + 1);
  });

  test('caps automatic channel backfill at four cursor pages and resumes only on demand', async ({
    context,
    page,
  }) => {
    const { channelId } = await seedThread(context, 310);
    const channelHistoryRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (
        request.method() === 'GET' &&
        url.includes(`/channels/${encodeURIComponent(channelId)}/messages`) &&
        url.includes('beforeSeq=')
      ) {
        channelHistoryRequests.push(url);
      }
    });

    await openChannel(page, { channelId });
    const continuation = page.getByRole('button', {
      name: 'load older channel history',
    });
    await expect(continuation).toBeVisible();
    await expect.poll(() => channelHistoryRequests.length).toBe(4);
    await page.waitForTimeout(500);
    expect(channelHistoryRequests).toHaveLength(4);
    await expect(page.getByText('load-bearing thread root')).toHaveCount(0);

    await continuation.click();
    await expect(page.getByText('load-bearing thread root')).toBeVisible();
    await expect
      .poll(() => channelHistoryRequests.length)
      .toBeGreaterThanOrEqual(5);
    await expect(
      page.getByRole('button', { name: '310 replies — open thread' })
    ).toBeVisible();
  });

  test('switching roots resets the panel follow lane to the bottom with no stale pill', async ({
    context,
    page,
  }) => {
    await authenticate(context);
    const channelId = await createChannel(context);
    const rootA = await postMessage(
      context.request,
      channelId,
      'thread switch root a'
    );
    for (let index = 1; index <= 70; index += 1) {
      await postMessage(
        context.request,
        channelId,
        `thread a reply ${String(index).padStart(2, '0')}`,
        rootA.id
      );
    }
    const rootB = await postMessage(
      context.request,
      channelId,
      'thread switch root b'
    );
    await postMessage(context.request, channelId, 'thread b reply 1', rootB.id);
    await postMessage(context.request, channelId, 'thread b reply 2', rootB.id);

    await openChannel(page, { channelId });
    await page
      .getByRole('button', { name: '70 replies — open thread' })
      .click();
    const panel = page.locator('.ch-thread');
    const scroll = panel.locator('.ch-thread__scroll');
    await expect(scroll.getByText('thread a reply 70')).toBeVisible();
    await scroll.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight > element.clientHeight
        )
      )
      .toBe(true);

    await page.getByRole('button', { name: '2 replies — open thread' }).click();
    await expect(panel.locator('.ch-thread__header')).toContainText(
      '2 replies'
    );
    await expect(scroll.getByText('thread b reply 2')).toBeVisible();
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight
        )
      )
      .toBeLessThanOrEqual(1);
    await expect(panel.locator('.ch-new-messages')).toHaveCount(0);
  });

  test('a hidden thread reply advances its count without moving the scrolled-up main lane', async ({
    context,
    page,
  }) => {
    await authenticate(context);
    const channelId = await createChannel(context);
    for (let index = 1; index <= 45; index += 1) {
      await postMessage(
        context.request,
        channelId,
        `top-level history ${String(index).padStart(2, '0')}`
      );
    }
    const root = await postMessage(
      context.request,
      channelId,
      'hidden reply scroll root'
    );
    await postMessage(
      context.request,
      channelId,
      'existing hidden reply',
      root.id
    );

    await openChannel(page, { channelId });
    const main = page.locator('.ch-tl');
    await main.evaluate((element) => {
      element.scrollTop = 100;
      element.dispatchEvent(new Event('scroll'));
    });
    const before = await main.evaluate((element) => element.scrollTop);
    expect(before).toBe(100);

    await postMessage(context.request, channelId, 'new hidden reply', root.id);
    await expect(
      page.getByRole('button', { name: '2 replies — open thread' })
    ).toHaveCount(1);
    await expect
      .poll(() => main.evaluate((element) => element.scrollTop))
      .toBe(before);
    await expect(page.locator('.ch-main .ch-new-messages')).toHaveCount(0);
    await expect(main.getByText('new hidden reply')).toHaveCount(0);
  });

  test('Escape dismisses an open thread mention palette before closing the panel', async ({
    context,
    page,
  }) => {
    const { channelId } = await seedThread(context, 1);
    await openChannel(page, { channelId });
    await page.getByRole('button', { name: '1 reply — open thread' }).click();

    const panel = page.locator('.ch-thread');
    const input = panel.getByRole('textbox', { name: 'message input' });
    await input.fill('draft survives @');
    const palette = panel.getByRole('listbox', { name: 'agents' });
    await expect(palette).toBeVisible();

    await input.press('Escape');
    await expect(palette).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(input).toHaveValue('draft survives @');

    await input.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('keeps the main composer interactive while a thread is open', async ({
    context,
    page,
  }) => {
    const { channelId } = await seedThread(context, 1);
    await openChannel(page, { channelId });
    await page.getByRole('button', { name: '1 reply — open thread' }).click();

    const panel = page.locator('.ch-thread');
    const main = page.locator('.ch-main');
    const mainInput = main.getByRole('textbox', { name: 'message input' });
    await mainInput.fill('root-level post while thread remains open');
    await mainInput.press('Enter');

    await expect(
      main
        .locator('.ch-tl')
        .getByText('root-level post while thread remains open')
    ).toBeVisible();
    await expect(
      panel
        .locator('.ch-thread__scroll')
        .getByText('root-level post while thread remains open')
    ).toHaveCount(0);
    await expect(panel.locator('.ch-thread__header')).toContainText('1 reply');
    await expect(
      page.getByRole('button', { name: '1 reply — open thread' })
    ).toHaveCount(1);
  });

  test('preserves the main-lane first visible row while opening and closing the desktop split', async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await authenticate(context);
    const channelId = await createChannel(context);
    let root: PostedMessage | null = null;
    for (let index = 1; index <= 60; index += 1) {
      const message = await postMessage(
        context.request,
        channelId,
        `desktop anchor row ${String(index).padStart(2, '0')} ${'wrapping content '.repeat(9)}`
      );
      if (index === 30) {
        root = message;
        await postMessage(
          context.request,
          channelId,
          'reply that enables the desktop thread chip',
          root.id
        );
      }
    }
    expect(root).not.toBeNull();

    await openChannel(page, { channelId });
    const mainLog = page.locator('.ch-main .ch-tl');
    await mainLog.evaluate((element) => {
      element.scrollTop = Math.max(
        1,
        element.scrollHeight - element.clientHeight - 500
      );
      element.dispatchEvent(new Event('scroll'));
    });
    const beforeOpen = await captureFirstVisible(mainLog);

    const chip = page.getByRole('button', {
      name: '1 reply — open thread',
    });
    await chip.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.locator('.ch-thread')).toBeVisible();
    await expectAnchorStable(mainLog, beforeOpen);

    const beforeClose = await captureFirstVisible(mainLog);
    await page
      .getByRole('button', { name: 'close thread' })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.locator('.ch-thread')).toHaveCount(0);
    await expectAnchorStable(mainLog, beforeClose);
  });

  test('uses a 380px desktop split, a mounted mobile overlay/back, and Escape close', async ({
    context,
    page,
  }) => {
    const { channelId } = await seedThread(context, 1);
    await openChannel(page, { channelId });
    await page.getByRole('button', { name: '1 reply — open thread' }).click();

    const panel = page.locator('.ch-thread');
    await expect
      .poll(async () => (await panel.boundingBox())?.width ?? 0)
      .toBeCloseTo(380, 0);
    await expect(page.locator('.ch-main')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 700 });
    const mobileBox = await panel.boundingBox();
    expect(mobileBox).not.toBeNull();
    expect(mobileBox!.x).toBeCloseTo(0, 0);
    expect(mobileBox!.y).toBeCloseTo(0, 0);
    expect(mobileBox!.width).toBeCloseTo(390, 0);
    expect(mobileBox!.height).toBeCloseTo(700, 0);
    await expect(panel.getByText('‹ back')).toBeVisible();
    expect(await page.locator('.ch-main').count()).toBe(1);

    const input = panel.getByRole('textbox', { name: 'message input' });
    await input.focus();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.ch-main')).toBeVisible();
  });
});
