import { expect, test } from '@playwright/test';

interface ComposerMetrics {
  clientHeight: number;
  scrollHeight: number;
  renderedHeight: number;
  composerHeight: number;
  chromeClientHeight: number;
  chromeScrollHeight: number;
  paneHeight: number;
  timelineHeight: number;
  oldSixLineCap: number;
  flexGrow: string;
}

async function composerMetrics(
  textarea: import('@playwright/test').Locator
): Promise<ComposerMetrics> {
  return textarea.evaluate((element) => {
    const composer = element.closest<HTMLElement>('.ch-composer');
    const pane = element.closest<HTMLElement>('.ch-main');
    const chrome = composer?.querySelector<HTMLElement>('.ch-composer__chrome');
    const timeline = pane?.querySelector<HTMLElement>(
      '[data-testid="timeline"]'
    );
    if (!composer || !chrome || !pane || !timeline)
      throw new Error('missing fixture layout');
    const computed = getComputedStyle(element);
    const lineHeight = Number.parseFloat(computed.lineHeight);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      renderedHeight: element.getBoundingClientRect().height,
      composerHeight: composer.getBoundingClientRect().height,
      chromeClientHeight: chrome.clientHeight,
      chromeScrollHeight: chrome.scrollHeight,
      paneHeight: pane.getBoundingClientRect().height,
      timelineHeight: timeline.getBoundingClientRect().height,
      oldSixLineCap: lineHeight * 6 + 32,
      flexGrow: computed.flexGrow,
    };
  });
}

test('composer grows beyond six lines and preserves a short mobile timeline (#1355)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/test-channel-composer.html');
  const textarea = page.getByRole('textbox', { name: 'message input' });
  await expect(textarea).toBeVisible();
  const oneLineHeight = (await composerMetrics(textarea)).renderedHeight;

  await textarea.fill(
    Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n')
  );
  await expect
    .poll(async () => (await composerMetrics(textarea)).renderedHeight)
    .toBeGreaterThan(200);
  const desktop = await composerMetrics(textarea);
  expect(desktop.flexGrow).toBe('0');
  expect(desktop.renderedHeight).toBeGreaterThan(desktop.oldSixLineCap);
  expect(desktop.scrollHeight - desktop.clientHeight).toBeLessThanOrEqual(1);

  await textarea.fill('short');
  await expect
    .poll(async () => (await composerMetrics(textarea)).renderedHeight)
    .toBeCloseTo(oneLineHeight, 0);
  const shrunk = await composerMetrics(textarea);
  expect(shrunk.renderedHeight).toBeGreaterThanOrEqual(oneLineHeight);
  expect(shrunk.scrollHeight - shrunk.clientHeight).toBeLessThanOrEqual(1);

  await textarea.fill('@');
  const palette = page.getByRole('listbox', { name: 'agents' });
  await expect(palette).toBeVisible();
  const paletteBounds = await palette.evaluate((element) => {
    const composer = element.closest<HTMLElement>('.ch-composer');
    if (!composer) throw new Error('missing composer');
    const paletteRect = element.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(
      paletteRect.left + paletteRect.width / 2,
      paletteRect.top + paletteRect.height / 2
    );
    return {
      height: paletteRect.height,
      bottom: paletteRect.bottom,
      composerTop: composer.getBoundingClientRect().top,
      hitTargetIsPalette: hitTarget !== null && element.contains(hitTarget),
    };
  });
  expect(paletteBounds.height).toBeGreaterThan(0);
  expect(paletteBounds.bottom).toBeLessThan(paletteBounds.composerTop);
  expect(paletteBounds.hitTargetIsPalette).toBe(true);

  await page.setViewportSize({ width: 390, height: 360 });
  await textarea.fill(
    Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
  );
  await expect
    .poll(async () => (await composerMetrics(textarea)).paneHeight)
    .toBe(360);
  await textarea.evaluate((element) => {
    const chrome = element
      .closest<HTMLElement>('.ch-composer')
      ?.querySelector<HTMLElement>('.ch-composer__chrome');
    if (!chrome) throw new Error('missing composer chrome');
    const largeChrome = document.createElement('div');
    largeChrome.dataset.testid = 'large-composer-chrome';
    largeChrome.style.cssText = 'height: 240px; flex: 0 0 240px;';
    chrome.append(largeChrome);
    window.dispatchEvent(new Event('resize'));
  });
  const mobile = await composerMetrics(textarea);
  expect(mobile.scrollHeight).toBeGreaterThan(mobile.clientHeight);
  expect(mobile.composerHeight).toBeLessThanOrEqual(
    mobile.paneHeight * 0.45 + 2
  );
  expect(mobile.chromeScrollHeight).toBeGreaterThan(mobile.chromeClientHeight);
  expect(mobile.timelineHeight).toBeGreaterThan(mobile.composerHeight);
});
