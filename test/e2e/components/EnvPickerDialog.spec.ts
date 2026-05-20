// EnvPickerDialog end-to-end coverage (#632) — drives the dialog through the
// four canonical scenarios from epic #615's acceptance criteria via the
// existing Playwright + Vite-fixture harness:
//
//   1. remote node selection      — launch carries the remote nodeId
//   2. local repo selection       — launch carries the local RepoIdentity
//                                   and local RepoInstance path
//   3. same-remote-different-path — picker aggregates by RepoIdentity into
//                                   ONE group with N instances; launching
//                                   each instance preserves the per-node
//                                   typed IDs (no silent substitution)
//   4. non-git cwd                — picker exposes a free / non-git group;
//                                   launch succeeds with `cwdMode: free`
//                                   and no repo-only capabilities surface
//
// Runtime budget: combined <30s. The fixture is a single page (one Vite
// build target, one webServer warm-up) and each test does at most two clicks
// and one assertion read, keeping wall-clock well inside budget.

import { test, expect, type Page, type Locator } from '@playwright/test';

interface LaunchedRecord {
  optionId: string;
  nodeId: string;
  nodeKind: 'local' | 'remote';
  repoIdentity: string | null;
  repoInstanceId: string | null;
  cwd: string;
  cwdMode: string;
}

async function readLaunched(page: Page): Promise<LaunchedRecord> {
  const raw = await page.getByTestId('launched-payload').textContent();
  if (!raw || raw.trim() === '' || raw.trim() === '(none)') {
    throw new Error('expected a launched payload, got: ' + String(raw));
  }
  return JSON.parse(raw) as LaunchedRecord;
}

function groupLabels(page: Page): Locator {
  return page.getByTestId('env-picker-group-label');
}

test.describe('EnvPickerDialog e2e — four picker scenarios (#632)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/test-env-picker-dialog.html');
    await page.waitForLoadState('networkidle');
  });

  test('1. remote node selection — launch carries the remote nodeId via typed IDs', async ({
    page,
  }) => {
    await page.getByTestId('open-remote').click();
    const dialog = page.getByTestId('env-picker-dialog');
    await expect(dialog).toBeVisible();

    // The remote node MUST surface in the picker (display name visible).
    await expect(page.getByText('dev mac', { exact: false })).toBeVisible();

    const row = dialog.locator('[data-option-id="mac::repo-relay"]');
    await expect(row).toBeVisible();
    await row.click();

    // After launch the dialog closes.
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('launched-count')).toHaveText('launches: 1');

    const launched = await readLaunched(page);
    expect(launched.optionId).toBe('mac::repo-relay');
    expect(launched.nodeId).toBe('mac');
    expect(launched.nodeKind).toBe('remote');
    expect(launched.repoIdentity).toBe('github.com/donovan-yohan/relay-ide');
    expect(launched.repoInstanceId).toBe('mac:/Users/dev/code/relay-ide');
    expect(launched.cwdMode).toBe('repo');
  });

  test('2. local repo selection — launch carries RepoIdentity + local RepoInstance path', async ({
    page,
  }) => {
    await page.getByTestId('open-local').click();
    const dialog = page.getByTestId('env-picker-dialog');
    await expect(dialog).toBeVisible();

    // Local repo group surfaces under its name.
    await expect(groupLabels(dialog)).toHaveText(['relay-ide']);

    const row = dialog.locator('[data-option-id="local::repo-relay"]');
    await expect(row).toBeVisible();
    await row.click();

    await expect(dialog).toBeHidden();
    const launched = await readLaunched(page);
    expect(launched.optionId).toBe('local::repo-relay');
    expect(launched.nodeId).toBe('local');
    expect(launched.nodeKind).toBe('local');
    expect(launched.repoIdentity).toBe('github.com/donovan-yohan/relay-ide');
    // RepoInstance present and its localPath matches the launch cwd
    // (`cwdMode: 'repo'` invariant in shared/environment-option.ts).
    expect(launched.repoInstanceId).toBe('local:/Users/dev/repos/relay-ide');
    expect(launched.cwd).toBe('/Users/dev/repos/relay-ide');
    expect(launched.cwdMode).toBe('repo');
  });

  test('3. same-remote-different-path — ONE group, N instances, no silent substitution', async ({
    page,
  }) => {
    await page.getByTestId('open-same-remote').click();
    const dialog = page.getByTestId('env-picker-dialog');
    await expect(dialog).toBeVisible();

    // CORE INVARIANT (#615): two repo instances with the SAME RepoIdentity on
    // DIFFERENT nodes/paths MUST aggregate into exactly ONE group.
    await expect(groupLabels(dialog)).toHaveText(['relay-ide']);

    // Both instances MUST be present as separate rows inside that group.
    const macRow = dialog.locator('[data-option-id="mac::repo-relay"]');
    const linuxRow = dialog.locator('[data-option-id="linux::repo-relay"]');
    await expect(macRow).toBeVisible();
    await expect(linuxRow).toBeVisible();
    await expect(dialog.locator('[role="option"]')).toHaveCount(2);

    // Pick the linux instance first.
    await linuxRow.click();
    await expect(dialog).toBeHidden();

    let launched = await readLaunched(page);
    expect(launched.nodeId).toBe('linux');
    expect(launched.repoInstanceId).toBe('linux:/srv/checkouts/relay-ide');
    expect(launched.cwd).toBe('/srv/checkouts/relay-ide');
    expect(launched.repoIdentity).toBe('github.com/donovan-yohan/relay-ide');

    // Re-open and pick the mac instance. The launch MUST land on `mac`, not
    // silently substitute the previously-launched `linux` or the other
    // instance under the same RepoIdentity.
    await page.getByTestId('open-same-remote').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-option-id="mac::repo-relay"]').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('launched-count')).toHaveText('launches: 2');

    launched = await readLaunched(page);
    expect(launched.nodeId).toBe('mac');
    expect(launched.repoInstanceId).toBe('mac:/Users/dev/code/relay-ide');
    expect(launched.cwd).toBe('/Users/dev/code/relay-ide');
    // Same RepoIdentity, but the per-node typed IDs are preserved.
    expect(launched.repoIdentity).toBe('github.com/donovan-yohan/relay-ide');
  });

  test('4. non-git cwd — picker shows free group; launch succeeds; no repo-only capabilities surface', async ({
    page,
  }) => {
    await page.getByTestId('open-non-git').click();
    const dialog = page.getByTestId('env-picker-dialog');
    await expect(dialog).toBeVisible();

    // The free / non-git cwd group surfaces with the dedicated label from
    // EnvironmentPicker.groupOptionsByRepoIdentity.
    await expect(groupLabels(dialog)).toHaveText(['non-git cwd']);

    const row = dialog.locator('[data-option-id="local::scratch"]');
    await expect(row).toBeVisible();

    // No repo-only capability (`rpc:git:*`) advertised on this option — the
    // picker must not surface git-only badges for a non-git cwd launch.
    const capabilities = row.getByTestId('env-picker-capability');
    await expect(capabilities).toHaveText(['session:create:terminal']);

    await row.click();
    await expect(dialog).toBeHidden();

    const launched = await readLaunched(page);
    expect(launched.optionId).toBe('local::scratch');
    expect(launched.nodeId).toBe('local');
    expect(launched.cwdMode).toBe('free');
    // No RepoIdentity / RepoInstance attached — the launch MUST NOT inherit
    // repo-only IDs from a sibling option (#615 acceptance criterion).
    expect(launched.repoIdentity).toBeNull();
    expect(launched.repoInstanceId).toBeNull();
  });
});
