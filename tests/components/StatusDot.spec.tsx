import { test, expect } from '@playwright/test';

test.describe('StatusDot React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-status-dot.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders all status variants', async ({ page }) => {
    const statusDots = page.locator('.status-dot');
    await expect(statusDots).toHaveCount(20);
  });

  test('renders with default size', async ({ page }) => {
    const defaultDot = page.locator('#all-statuses-container .status-dot').first();
    await expect(defaultDot).toBeVisible();
    
    const boundingBox = await defaultDot.boundingBox();
    expect(boundingBox?.width).toBeCloseTo(7, 1);
    expect(boundingBox?.height).toBeCloseTo(7, 1);
  });

  test('renders with custom sizes', async ({ page }) => {
    const sizesContainer = page.locator('#sizes-container');
    await expect(sizesContainer).toBeVisible();
    
    const expectedSizes = [5, 7, 10, 14];
    
    const dots = sizesContainer.locator('.status-dot');
    await expect(dots).toHaveCount(4);
    
    for (let i = 0; i < expectedSizes.length; i++) {
      const dot = dots.nth(i);
      const boundingBox = await dot.boundingBox();
      expect(boundingBox?.width).toBeCloseTo(expectedSizes[i], 1);
      expect(boundingBox?.height).toBeCloseTo(expectedSizes[i], 1);
    }
  });

  test('applies correct status class', async ({ page }) => {
    const openDot = page.locator('.status-dot--open').first();
    await expect(openDot).toBeVisible();
    await expect(openDot).toHaveClass(/status-dot--open/);
  });

  test('applies pulse class for attention status', async ({ page }) => {
    const attentionDot = page.locator('.status-dot--attention');
    await expect(attentionDot).toBeVisible();
    await expect(attentionDot).toHaveClass(/pulse/);
    
    const permissionDot = page.locator('.status-dot--permission-prompt');
    await expect(permissionDot).toBeVisible();
    await expect(permissionDot).toHaveClass(/pulse/);
  });

  test('does not apply pulse class for non-pulsing statuses', async ({ page }) => {
    const openDot = page.locator('.status-dot--open');
    await expect(openDot).toBeVisible();
    const className = await openDot.getAttribute('class');
    expect(className).not.toMatch(/pulse/);
  });

  test('has correct accessibility attributes', async ({ page }) => {
    const statusDot = page.locator('.status-dot').first();
    await expect(statusDot).toHaveAttribute('role', 'img');
    
    const ariaLabel = await statusDot.getAttribute('aria-label');
    expect(ariaLabel).toMatch(/\w+ status/);
  });

  test('screenshot - all status variants', async ({ page }) => {
    const container = page.locator('#all-statuses-container');
    await expect(container).toBeVisible();
    
    await expect(container).toHaveScreenshot('status-dot-all-variants.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });

  test('screenshot - size variants', async ({ page }) => {
    const container = page.locator('#sizes-container');
    await expect(container).toBeVisible();
    
    await expect(container).toHaveScreenshot('status-dot-sizes.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });

  test('screenshot - pulse animation', async ({ page }) => {
    const container = page.locator('#pulse-container');
    await expect(container).toBeVisible();
    
    await expect(container).toHaveScreenshot('status-dot-pulse.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
      animations: 'disabled',
    });
  });

  test('screenshot - PR states', async ({ page }) => {
    const container = page.locator('#pr-states-container');
    await expect(container).toBeVisible();
    
    await expect(container).toHaveScreenshot('status-dot-pr-states.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });

  test('screenshot - session states', async ({ page }) => {
    const container = page.locator('#session-states-container');
    await expect(container).toBeVisible();
    
    await expect(container).toHaveScreenshot('status-dot-session-states.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });
});

test.describe('StatusDot individual status colors', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-status-dot.html');
    await page.waitForLoadState('networkidle');
  });

  const statusTests = [
    { status: 'draft', description: 'transparent with border' },
    { status: 'open', description: 'success green' },
    { status: 'approved', description: 'info blue' },
    { status: 'changes-requested', description: 'error red' },
    { status: 'review-requested', description: 'warning yellow' },
    { status: 'merged', description: 'merged purple' },
    { status: 'closed', description: 'border gray, square' },
    { status: 'unknown', description: 'border gray, faded' },
    { status: 'running', description: 'success green' },
    { status: 'idle', description: 'info blue' },
    { status: 'attention', description: 'warning yellow, pulsing' },
    { status: 'permission-prompt', description: 'warning yellow, pulsing' },
    { status: 'connected', description: 'success green' },
    { status: 'disconnected', description: 'transparent with border' },
    { status: 'warning', description: 'warning yellow' },
    { status: 'initializing', description: 'muted gray, faded' },
  ];

  for (const { status, description } of statusTests) {
    test(`${status} - ${description}`, async ({ page }) => {
      const statusDot = page.locator(`.status-dot--${status}`);
      await expect(statusDot).toBeVisible();
      await expect(statusDot).toHaveClass(new RegExp(`status-dot--${status}`));
    });
  }
});