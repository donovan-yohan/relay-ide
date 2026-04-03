import { test, expect } from '@playwright/test';

test.describe('SessionIndicator React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-session-indicator.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders all session states', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const indicators = container.locator('.session-indicator');
    await expect(indicators).toHaveCount(8);
  });

  test('renders correct character for each state', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const stateChars: Record<string, string> = {
      initializing: '●',
      running: '●',
      'unseen-idle': '▶',
      'seen-idle': '▶',
      permission: '◆',
      'needs-answer': '◇',
      error: '■',
      inactive: '─',
    };

    for (const [state, expectedChar] of Object.entries(stateChars)) {
      const indicator = container.locator(
        `.status-item:has(.status-label:text-is("${state}")) .session-indicator`
      );
      await expect(indicator).toHaveText(expectedChar);
    }
  });

  test('applies correct color class for each state', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const stateColors: Record<string, string> = {
      initializing: 'ind-green-dim',
      running: 'ind-green',
      'unseen-idle': 'ind-yellow',
      'seen-idle': 'ind-yellow-muted',
      permission: 'ind-red',
      'needs-answer': 'ind-red',
      error: 'ind-red',
      inactive: 'ind-gray',
    };

    for (const [state, expectedClass] of Object.entries(stateColors)) {
      const indicator = container.locator(
        `.status-item:has(.status-label:text-is("${state}")) .session-indicator`
      );
      await expect(indicator).toHaveClass(new RegExp(expectedClass));
    }
  });

  test('applies pulse-fast for permission and needs-answer states', async ({
    page,
  }) => {
    const container = page.locator('#all-states-container');

    const permissionIndicator = container.locator(
      `.status-item:has(.status-label:text("permission")) .session-indicator`
    );
    await expect(permissionIndicator).toHaveClass(/pulse-fast/);

    const needsAnswerIndicator = container.locator(
      `.status-item:has(.status-label:text("needs-answer")) .session-indicator`
    );
    await expect(needsAnswerIndicator).toHaveClass(/pulse-fast/);
  });

  test('applies pulse-slow for unseen-idle state', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const unseenIdleIndicator = container.locator(
      `.status-item:has(.status-label:text("unseen-idle")) .session-indicator`
    );
    await expect(unseenIdleIndicator).toHaveClass(/pulse-slow/);
  });

  test('does not apply pulse class for non-pulsing states', async ({
    page,
  }) => {
    const container = page.locator('#non-pulse-container');
    const runningIndicator = container.locator(
      `.status-item:has(.status-label:text("running")) .session-indicator`
    );
    const className = await runningIndicator.getAttribute('class');
    expect(className).not.toMatch(/pulse-fast|pulse-slow/);
  });

  test('applies bold style for permission and needs-answer states', async ({
    page,
  }) => {
    const container = page.locator('#bold-container');

    const permissionIndicator = container.locator(
      `.status-item:has(.status-label:text("permission")) .session-indicator`
    );
    const permissionStyle = await permissionIndicator.getAttribute('style');
    expect(permissionStyle).toContain('font-weight: 700');

    const needsAnswerIndicator = container.locator(
      `.status-item:has(.status-label:text("needs-answer")) .session-indicator`
    );
    const needsAnswerStyle = await needsAnswerIndicator.getAttribute('style');
    expect(needsAnswerStyle).toContain('font-weight: 700');
  });

  test('does not apply bold style for non-bold states', async ({ page }) => {
    const container = page.locator('#non-pulse-container');
    const runningIndicator = container.locator(
      `.status-item:has(.status-label:text("running")) .session-indicator`
    );
    const style = await runningIndicator.getAttribute('style');
    expect(style).toBeNull();
  });

  test('has correct accessibility attributes', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const indicator = container.locator('.session-indicator').first();
    await expect(indicator).toHaveAttribute('role', 'img');
  });

  test('has correct aria-label for permission state', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const permissionIndicator = container.locator(
      `.status-item:has(.status-label:text("permission")) .session-indicator`
    );
    await expect(permissionIndicator).toHaveAttribute(
      'aria-label',
      'needs approval'
    );
  });

  test('has correct aria-label for needs-answer state', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const needsAnswerIndicator = container.locator(
      `.status-item:has(.status-label:text("needs-answer")) .session-indicator`
    );
    await expect(needsAnswerIndicator).toHaveAttribute(
      'aria-label',
      'needs answer'
    );
  });

  test('has correct aria-label for unseen-idle state', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const unseenIdleIndicator = container.locator(
      `.status-item:has(.status-label:text("unseen-idle")) .session-indicator`
    );
    await expect(unseenIdleIndicator).toHaveAttribute(
      'aria-label',
      'idle, unread'
    );
  });

  test('has correct aria-label for seen-idle state', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const seenIdleIndicator = container.locator(
      `.status-item:has(.status-label:text-is("seen-idle")) .session-indicator`
    );
    await expect(seenIdleIndicator).toHaveAttribute('aria-label', 'idle');
  });

  test('has correct aria-label for other states', async ({ page }) => {
    const container = page.locator('#all-states-container');
    const runningIndicator = container.locator(
      `.status-item:has(.status-label:text("running")) .session-indicator`
    );
    await expect(runningIndicator).toHaveAttribute('aria-label', 'running');
  });

  test('screenshot - all session states', async ({ page }) => {
    const container = page.locator('#all-states-container');
    await expect(container).toBeVisible();

    await expect(container).toHaveScreenshot(
      'session-indicator-all-states.png',
      {
        maxDiffPixels: 100,
        threshold: 0.2,
      }
    );
  });

  test('screenshot - pulsing states', async ({ page }) => {
    const container = page.locator('#pulse-container');
    await expect(container).toBeVisible();

    await expect(container).toHaveScreenshot('session-indicator-pulse.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
      animations: 'disabled',
    });
  });

  test('screenshot - bold states', async ({ page }) => {
    const container = page.locator('#bold-container');
    await expect(container).toBeVisible();

    await expect(container).toHaveScreenshot('session-indicator-bold.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });
});
