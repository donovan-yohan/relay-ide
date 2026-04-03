import { test, expect } from '@playwright/test';

test.describe('AgentBadge', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-agent-badge.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders claude SVG badge', async ({ page }) => {
    const badge = page.locator('svg[aria-label="Claude"]').first();
    await expect(badge).toBeVisible();
  });

  test('renders codex SVG badge', async ({ page }) => {
    const badge = page.locator('svg[aria-label="Codex"]').first();
    await expect(badge).toBeVisible();
  });

  test('renders opencode SVG badge', async ({ page }) => {
    const badge = page.locator('svg[aria-label="OpenCode"]').first();
    await expect(badge).toBeVisible();
  });

  test('renders fallback letter for unknown agent', async ({ page }) => {
    const fallback = page.locator('.agent-badge--fallback').first();
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText('M');
  });

  test('screenshot - default', async ({ page }) => {
    const el = page.locator('#test-container');
    await expect(el).toHaveScreenshot('agent-badge-default.png', {
      maxDiffPixels: 100,
      threshold: 0.1,
    });
  });
});
