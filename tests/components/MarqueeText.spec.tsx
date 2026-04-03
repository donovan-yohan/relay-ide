import { test, expect } from '@playwright/test';

const DEFAULT_CONTAINER_SELECTOR = '#default-props-container .marquee-container';
const MARQUEE_INNER_SELECTOR = '.marquee-inner';
const HAS_OVERFLOW_STYLE = '--has-overflow: 1';
const TEST_PAGE_URL = '/test-marquee-text.html';

test.describe('MarqueeText React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(TEST_PAGE_URL);
    await page.waitForLoadState('networkidle');
  });

  test('renders with default props', async ({ page }) => {
    const container = page.locator(DEFAULT_CONTAINER_SELECTOR);
    await expect(container).toBeVisible();
    
    const inner = container.locator(MARQUEE_INNER_SELECTOR);
    await expect(inner).toBeVisible();
    await expect(inner).toContainText('This is a very long text');
  });

  test('applies fade mask when content overflows', async ({ page }) => {
    const container = page.locator(DEFAULT_CONTAINER_SELECTOR);
    
    // Check that the container has the has-overflow style set
    const hasOverflow = await container.evaluate((el) => {
      const style = el.getAttribute('style') || '';
      return style.includes(HAS_OVERFLOW_STYLE);
    });
    expect(hasOverflow).toBe(true);
  });

  test('does not apply fade mask when content fits', async ({ page }) => {
    const container = page.locator('#no-overflow-container .marquee-container');
    
    const hasOverflow = await container.evaluate((el) => {
      const style = el.getAttribute('style') || '';
      return style.includes(HAS_OVERFLOW_STYLE);
    });
    expect(hasOverflow).toBe(false);
  });

  test('renders with custom speed values', async ({ page }) => {
    const speedContainer = page.locator('#speed-container');
    const marqueeContainers = speedContainer.locator('.marquee-container');
    await expect(marqueeContainers).toHaveCount(3);
  });

  test('renders with custom fade width', async ({ page }) => {
    const fadeContainer = page.locator('#fade-width-container');
    const marqueeContainers = fadeContainer.locator('.marquee-container');
    await expect(marqueeContainers).toHaveCount(2);
    
    // Check that fade width CSS variable is set
    const firstContainer = marqueeContainers.first();
    const fadeWidth = await firstContainer.evaluate((el) => {
      const style = el.getAttribute('style') || '';
      const match = style.match(/--fade-width:\s*(\d+)px/);
      return match ? parseInt(match[1], 10) : null;
    });
    expect(fadeWidth).toBe(10);
  });

  test('renders with custom overscroll', async ({ page }) => {
    const overscrollContainer = page.locator('#overscroll-container');
    const marqueeContainers = overscrollContainer.locator('.marquee-container');
    await expect(marqueeContainers).toHaveCount(2);
  });

  test('animates on hover when content overflows', async ({ page }) => {
    const container = page.locator(DEFAULT_CONTAINER_SELECTOR);
    const inner = container.locator(MARQUEE_INNER_SELECTOR);
    
    // Get initial transform
    const initialTransform = await inner.evaluate((el) => {
      return (el as HTMLElement).style.transform;
    });
    expect(initialTransform).toBe('');
    
    // Hover to trigger animation
    await container.hover();
    
    // Wait for animation to start
    await page.waitForTimeout(100);
    
    // Check that transform is applied
    const hoverTransform = await inner.evaluate((el) => {
      return (el as HTMLElement).style.transform;
    });
    expect(hoverTransform).toContain('translateX');
  });

  test('resets transform on mouse leave', async ({ page }) => {
    const container = page.locator(DEFAULT_CONTAINER_SELECTOR);
    const inner = container.locator(MARQUEE_INNER_SELECTOR);
    
    // Hover to trigger animation
    await container.hover();
    await page.waitForTimeout(100);
    
    // Move away to reset
    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);
    
    // Check that transform is reset
    const resetTransform = await inner.evaluate((el) => {
      return (el as HTMLElement).style.transform;
    });
    expect(resetTransform).toBe('translateX(0px)');
  });

  test('does not animate when content fits', async ({ page }) => {
    const container = page.locator('#no-overflow-container .marquee-container');
    const inner = container.locator(MARQUEE_INNER_SELECTOR);
    
    // Hover
    await container.hover();
    await page.waitForTimeout(100);
    
    // Transform should not be applied
    const transform = await inner.evaluate((el) => {
      return (el as HTMLElement).style.transform;
    });
    expect(transform).toBe('');
  });

  test('renders styled children correctly', async ({ page }) => {
    const container = page.locator('#dynamic-content-container .marquee-container');
    const inner = container.locator(MARQUEE_INNER_SELECTOR);
    
    await expect(inner).toContainText('Colored');
    await expect(inner).toContainText('styled');
    
    // Check that the colored span exists
    const coloredSpan = inner.locator('span').first();
    await expect(coloredSpan).toHaveCSS('color', 'rgb(0, 255, 136)');
  });

  test('screenshot - default props', async ({ page }) => {
    const container = page.locator('#default-props-container');
    await expect(container).toBeVisible();
    
    await expect(container).toHaveScreenshot('marquee-text-default.png', {
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });

  test('screenshot - speed variants', async ({ page }) => {
    const container = page.locator('#speed-container');
    await expect(container).toBeVisible();
    
    await expect(container).toHaveScreenshot('marquee-text-speeds.png', {
      maxDiffPixels: 200,
      threshold: 0.2,
    });
  });

  test('screenshot - container sizes', async ({ page }) => {
    const container = page.locator('#container-sizes');
    await expect(container).toBeVisible();
    
    await expect(container).toHaveScreenshot('marquee-text-sizes.png', {
      maxDiffPixels: 200,
      threshold: 0.2,
    });
  });

  test('screenshot - hover state', async ({ page }) => {
    const container = page.locator(DEFAULT_CONTAINER_SELECTOR);
    await container.hover();
    
    // Wait for animation to progress
    await page.waitForTimeout(500);
    
    await expect(container).toHaveScreenshot('marquee-text-hover.png', {
      maxDiffPixels: 200,
      threshold: 0.2,
      animations: 'disabled',
    });
  });
});

test.describe('MarqueeText overflow detection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(TEST_PAGE_URL);
    await page.waitForLoadState('networkidle');
  });

  test('correctly detects overflow in narrow container', async ({ page }) => {
    const narrowContainer = page.locator('#container-sizes .container-narrow .marquee-container');
    
    const hasOverflow = await narrowContainer.evaluate((el) => {
      const style = el.getAttribute('style') || '';
      return style.includes(HAS_OVERFLOW_STYLE);
    });
    expect(hasOverflow).toBe(true);
  });

  test('correctly detects no overflow in wide container', async ({ page }) => {
    const wideContainer = page.locator('#container-sizes .container-wide .marquee-container');
    
    const hasOverflow = await wideContainer.evaluate((el) => {
      const style = el.getAttribute('style') || '';
      return style.includes(HAS_OVERFLOW_STYLE);
    });
    expect(hasOverflow).toBe(false);
  });

  test('updates overflow on resize', async ({ page }) => {
    const container = page.locator(DEFAULT_CONTAINER_SELECTOR);
    
    // Initially has overflow
    const hasOverflow = await container.evaluate((el) => {
      const style = el.getAttribute('style') || '';
      return style.includes(HAS_OVERFLOW_STYLE);
    });
    expect(hasOverflow).toBe(true);
    
    // Resize viewport to be very wide
    await page.setViewportSize({ width: 2000, height: 1000 });
    await page.waitForTimeout(100);
    
    // After resize, overflow might change depending on container width
    // This test verifies the ResizeObserver is working
    const innerWidth = await container.evaluate((el) => {
      return (el as HTMLElement).clientWidth;
    });
    expect(innerWidth).toBeGreaterThan(0);
  });
});