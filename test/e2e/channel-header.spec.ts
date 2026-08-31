import { expect, test } from '@playwright/test';

const DESIGNATION_ERROR = 'channel already has a non-orchestrator agent bound';

test('bounds the designation alert without collapsing the 320px channel header', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/test-channel-header.html');

  const header = page.getByTestId('channel-header');
  const title = header.locator('.ch-header__title');
  const error = page.getByRole('alert');
  const dot = header.locator('.ch-conn-dot');

  await expect(header).toBeVisible();
  await expect(title).toHaveText('#operator lane');
  await expect(error).toHaveText(DESIGNATION_ERROR);
  await expect(dot).toHaveAccessibleName('connected');

  const metrics = await header.evaluate((element: HTMLElement) => {
    const titleElement =
      element.querySelector<HTMLElement>('.ch-header__title');
    const errorElement = element.querySelector<HTMLElement>(
      '.ch-designate-orchestrator__error'
    );
    const dotElement = element.querySelector<HTMLElement>('.ch-conn-dot');
    if (!titleElement || !errorElement || !dotElement) {
      throw new Error('missing channel header fixture geometry');
    }
    const rect = (target: HTMLElement) => {
      const bounds = target.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const errorStyle = getComputedStyle(errorElement);
    const titleStyle = getComputedStyle(titleElement);
    const dotStyle = getComputedStyle(dotElement);
    return {
      header: rect(element),
      title: rect(titleElement),
      error: rect(errorElement),
      dot: rect(dotElement),
      headerClientWidth: element.clientWidth,
      headerScrollWidth: element.scrollWidth,
      errorLineHeight: Number.parseFloat(errorStyle.lineHeight),
      errorOverflow: errorStyle.overflow,
      errorOrder: errorStyle.order,
      titleMinWidth: Number.parseFloat(titleStyle.minWidth),
      titleOverflow: titleStyle.overflow,
      dotFlexShrink: dotStyle.flexShrink,
      fullErrorText: errorElement.textContent,
    };
  });

  expect(metrics.header.width).toBe(320);
  expect(metrics.header.height).toBeLessThan(90);
  expect(metrics.headerScrollWidth).toBeLessThanOrEqual(
    metrics.headerClientWidth
  );

  expect(metrics.error.top).toBeGreaterThanOrEqual(metrics.title.bottom + 3);
  expect(metrics.error.top).toBeGreaterThanOrEqual(metrics.dot.bottom + 3);
  expect(metrics.error.left).toBeGreaterThanOrEqual(metrics.header.left + 9);
  expect(metrics.error.right).toBeLessThanOrEqual(metrics.header.right - 9);
  expect(metrics.error.height).toBeGreaterThan(metrics.errorLineHeight);
  expect(metrics.error.height).toBeLessThanOrEqual(
    metrics.errorLineHeight * 2 + 1
  );
  expect(metrics.errorOverflow).toBe('hidden');
  expect(metrics.errorOrder).toBe('1');
  expect(metrics.fullErrorText?.trim()).toBe(DESIGNATION_ERROR);

  expect(metrics.title.width).toBeGreaterThanOrEqual(metrics.titleMinWidth);
  expect(metrics.title.width).toBeGreaterThan(25);
  expect(metrics.title.height).toBeGreaterThan(0);
  expect(metrics.titleOverflow).toBe('hidden');

  expect(metrics.dot.width).toBe(8);
  expect(metrics.dot.height).toBe(8);
  expect(metrics.dotFlexShrink).toBe('0');
});
