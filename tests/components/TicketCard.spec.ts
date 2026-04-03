import { test, expect } from '@playwright/test';

test.describe('TicketCard React component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-ticket-card.html');
    await page.waitForLoadState('networkidle');
  });

  test('renders GitHub open issue with title link', async ({ page }) => {
    const card = page.locator('#github-open .ticket-card');
    await expect(card).toBeVisible();
    const link = card.locator('.ticket-title-link');
    await expect(link).toHaveText('Fix keyboard navigation in OpenPicker component');
    await expect(link).toHaveAttribute('href', 'https://github.com/example/repo/issues/42');
  });

  test('renders GitHub issue number and repo chip', async ({ page }) => {
    const card = page.locator('#github-open .ticket-card');
    await expect(card.locator('.ticket-number')).toHaveText('#42');
    await expect(card.locator('.repo-chip')).toHaveText('relay-ide');
  });

  test('renders label chips', async ({ page }) => {
    const card = page.locator('#github-open .ticket-card');
    const labels = card.locator('.label-chip');
    await expect(labels).toHaveCount(2);
  });

  test('start work button is active when handler provided', async ({ page }) => {
    const btn = page.locator('#github-open .start-work-btn');
    await expect(btn).toHaveClass(/start-work-btn--active/);
    await expect(btn).not.toBeDisabled();
  });

  test('start work button is disabled without handler', async ({ page }) => {
    const btn = page.locator('#github-closed .start-work-btn');
    await expect(btn).not.toHaveClass(/start-work-btn--active/);
    await expect(btn).toBeDisabled();
  });

  test('renders branch chip with active session dot', async ({ page }) => {
    const card = page.locator('#github-with-branch .ticket-card');
    await expect(card.locator('.branch-chip')).toBeVisible();
    await expect(card.locator('.branch-chip .status-dot')).toBeVisible();
  });

  test('renders Jira issue with key, status and priority', async ({ page }) => {
    const card = page.locator('#jira-in-progress .ticket-card');
    await expect(card.locator('.ticket-key')).toHaveText('PROJ-123');
    await expect(card.locator('.status-badge')).toHaveText('In Progress');
    await expect(card.locator('.priority-badge')).toHaveText('High');
  });

  test('renders Jira sprint and story points', async ({ page }) => {
    const card = page.locator('#jira-in-progress .ticket-card');
    await expect(card.locator('.sprint-chip')).toHaveText('Sprint 14');
    await expect(card.locator('.points-badge')).toHaveText('5pt');
  });

  test('screenshot - github open issue', async ({ page }) => {
    const container = page.locator('#github-open');
    await expect(container).toHaveScreenshot('ticket-card-github-open.png', {
      maxDiffPixels: 120,
      threshold: 0.2,
    });
  });
});
