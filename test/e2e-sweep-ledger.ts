/**
 * The #1299 sweep ledger, as data instead of prose.
 *
 * `docs/QUALITY.md` used to carry the "why each spec was deleted" table on its
 * own. Review found three of its eighteen "already covered by a vitest test"
 * claims were wrong — a module that no longer exists, and a module the credited
 * test explicitly `vi.mock`s away. That column is the artifact a future
 * maintainer trusts when deciding "safe, already covered", so an unverified
 * column is worse than no column.
 *
 * So the ledger lives here and `test/e2e-sweep-ledger.test.ts` checks it:
 *   - `dead-surface` must have no module, or a module nothing imports.
 *   - `covered-elsewhere` must name a live module AND every credited vitest
 *     file must actually reach it through the real import graph, with
 *     `vi.mock`ed edges cut (that is what caught the `DiffViewer` credit).
 *   - `uncovered-gap` must name a live module with no credited coverage.
 *
 * The doc keeps the narrative and cites the counts; the test asserts the doc's
 * numbers against this array so the two cannot drift.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const REPO_ROOT = resolve(HERE, '..');
export const FRONTEND_SRC = join(REPO_ROOT, 'frontend', 'src');

export type SweptSpecGroup =
  | 'dead-surface'
  | 'covered-elsewhere'
  | 'uncovered-gap';

export interface SweptSpec {
  /** Component the deleted spec was named for: `<component>.spec.ts(x)`. */
  component: string;
  group: SweptSpecGroup;
  /**
   * Repo-relative module path, when the component still exists in the app.
   * Omitted for `dead-surface` entries whose module is gone from the tree.
   */
  module?: string;
  /**
   * Vitest files that render the module — directly or through a parent that
   * imports it. Only meaningful for `covered-elsewhere`, and every entry is
   * verified against the import graph.
   */
  coveredBy?: string[];
  /** Short human note; free text, not checked. */
  note?: string;
}

/**
 * Every spec deleted by the #1299 sweep, one entry per spec.
 *
 * Ordering is by group then name so the file reads like the doc table.
 */
export const SWEPT_SPECS: readonly SweptSpec[] = [
  // (a) Dead surface — nothing to re-cover.
  {
    component: 'ChangedFiles',
    group: 'dead-surface',
    module: 'frontend/src/components/ChangedFiles.tsx',
  },
  {
    component: 'FileTreeSidebar',
    group: 'dead-surface',
    note: 'no such module in frontend/src; the surviving FileTree emits none of the `.file-tree-sidebar__*` classes the deleted spec asserted',
  },
  {
    component: 'FilterChipBar',
    group: 'dead-surface',
    module: 'frontend/src/components/FilterChipBar.tsx',
  },
  {
    component: 'MobileInput',
    group: 'dead-surface',
    module: 'frontend/src/components/MobileInput.tsx',
    note: 'the mobile-input pipeline keeps its own coverage via test/mobile-input.test.ts',
  },
  {
    component: 'PickerResultRow',
    group: 'dead-surface',
    module: 'frontend/src/components/PickerResultRow.tsx',
  },
  {
    component: 'PrGlyph',
    group: 'dead-surface',
    module: 'frontend/src/components/PrGlyph.tsx',
  },
  {
    component: 'SessionIndicator',
    group: 'dead-surface',
    module: 'frontend/src/components/SessionIndicator.tsx',
  },
  {
    component: 'SessionItem',
    group: 'dead-surface',
    module: 'frontend/src/components/SessionItem.tsx',
  },
  {
    component: 'ShortcutHint',
    group: 'dead-surface',
    module: 'frontend/src/components/ShortcutHint.tsx',
  },
  {
    component: 'StatusMappingModal',
    group: 'dead-surface',
    module: 'frontend/src/components/StatusMappingModal.tsx',
  },
  {
    component: 'TuiRow',
    group: 'dead-surface',
    module: 'frontend/src/components/TuiRow.tsx',
  },
  {
    component: 'WorkspaceItem',
    group: 'dead-surface',
    note: 'module deleted from the tree',
  },

  // (b) Live surface still loaded for real by a vitest suite.
  {
    component: 'CommandPalette',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/CommandPalette.tsx',
    coveredBy: ['test/command-palette-message-search.test.ts'],
  },
  {
    component: 'DeleteWorktreeDialog',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/dialogs/DeleteWorktreeDialog.tsx',
    coveredBy: ['test/workspace-lifecycle-registry.test.ts'],
  },
  {
    component: 'DialogShell',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/dialogs/DialogShell.tsx',
    coveredBy: ['test/components/AddWorkspaceDialog.test.ts'],
    note: 'that suite asserts the `<dialog>` open state and aria-label DialogShell renders',
  },
  {
    component: 'DiffFileSidebar',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/DiffFileSidebar.tsx',
    coveredBy: ['test/components/UtilityRailReviewPanel.test.ts'],
    note: 'that suite clicks a real `.sidebar-file` row',
  },
  {
    component: 'DiffSourceToggle',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/DiffSourceToggle.tsx',
    coveredBy: ['test/components/UtilityRailReviewPanel.test.ts'],
  },
  {
    component: 'DiffViewer',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/DiffViewer.tsx',
    coveredBy: ['test/components/file-surface-parity.test.ts'],
    note: 'NOT UtilityRailReviewPanel.test.ts — that suite vi.mocks DiffViewer away',
  },
  {
    component: 'FilePicker',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/FilePicker.tsx',
    coveredBy: ['test/components/FilePicker.test.ts'],
  },
  {
    component: 'PrTopBar',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/PrTopBar.tsx',
    coveredBy: ['test/pr-top-bar-action.test.ts'],
  },
  {
    component: 'RepoDashboard',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/RepoDashboard.tsx',
    coveredBy: ['test/repo-dashboard-tickets-flow.test.ts'],
  },
  {
    component: 'SearchableSelect',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/SearchableSelect.tsx',
    coveredBy: ['test/components/SettingsAgentProfilesSection.test.ts'],
  },
  {
    component: 'TuiButton',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/TuiButton.tsx',
    coveredBy: ['test/components/Tooltip.test.ts'],
  },
  {
    component: 'TuiProgress',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/TuiProgress.tsx',
    coveredBy: ['test/components/channel-timeline-presence.test.ts'],
    note: 'NOT repo-dashboard-tickets-flow.test.ts — that suite vi.mocks TuiProgress away',
  },
  {
    component: 'WorkspaceEditor',
    group: 'covered-elsewhere',
    module: 'frontend/src/components/dialogs/WorkspaceEditor.tsx',
    coveredBy: ['test/workspace-lifecycle-registry.test.ts'],
  },

  // (c) Live surface with no behavioural coverage — a real, recorded gap.
  {
    component: 'AgentBadge',
    group: 'uncovered-gap',
    module: 'frontend/src/components/AgentBadge.tsx',
  },
  {
    component: 'AnalyticsDashboard',
    group: 'uncovered-gap',
    module: 'frontend/src/components/AnalyticsDashboard.tsx',
  },
  {
    component: 'BootScreen',
    group: 'uncovered-gap',
    module: 'frontend/src/components/BootScreen.tsx',
  },
  {
    component: 'BranchSwitcher',
    group: 'uncovered-gap',
    module: 'frontend/src/components/BranchSwitcher.tsx',
    note: 'pr-top-bar-action.test.ts vi.mocks it away, so it was never covered there',
  },
  {
    component: 'CipherText',
    group: 'uncovered-gap',
    module: 'frontend/src/components/CipherText.tsx',
    note: 'its spec asserted `.cipher-text` at `/`, where only the transient BootScreen renders it; 2 of its 5 tests failed on a real run, so it was removed in review rather than kept as a coin flip',
  },
  {
    component: 'ContextMenu',
    group: 'uncovered-gap',
    module: 'frontend/src/components/ContextMenu.tsx',
  },
  {
    component: 'DataTable',
    group: 'uncovered-gap',
    module: 'frontend/src/components/DataTable.tsx',
  },
  {
    component: 'GitHubIntegration',
    group: 'uncovered-gap',
    module:
      'frontend/src/components/dialogs/integrations/GitHubIntegration.tsx',
  },
  {
    component: 'ImageToast',
    group: 'uncovered-gap',
    module: 'frontend/src/components/ImageToast.tsx',
  },
  {
    component: 'IntegrationRow',
    group: 'uncovered-gap',
    module: 'frontend/src/components/dialogs/integrations/IntegrationRow.tsx',
  },
  {
    component: 'JiraIntegration',
    group: 'uncovered-gap',
    module: 'frontend/src/components/dialogs/integrations/JiraIntegration.tsx',
  },
  {
    component: 'MarqueeText',
    group: 'uncovered-gap',
    module: 'frontend/src/components/MarqueeText.tsx',
  },
  {
    component: 'MobileHeader',
    group: 'uncovered-gap',
    module: 'frontend/src/components/MobileHeader.tsx',
  },
  {
    component: 'OpenPicker',
    group: 'uncovered-gap',
    module: 'frontend/src/components/OpenPicker.tsx',
  },
  {
    component: 'OrgDashboard',
    group: 'uncovered-gap',
    module: 'frontend/src/components/OrgDashboard.tsx',
  },
  {
    component: 'PinGate',
    group: 'uncovered-gap',
    module: 'frontend/src/components/PinGate.tsx',
  },
  {
    component: 'PinInput',
    group: 'uncovered-gap',
    module: 'frontend/src/components/PinInput.tsx',
  },
  {
    component: 'RenameWarningModal',
    group: 'uncovered-gap',
    module: 'frontend/src/components/dialogs/RenameWarningModal.tsx',
    note: 'pr-top-bar-action.test.ts vi.mocks it away, so it was never covered there',
  },
  {
    component: 'SessionDetail',
    group: 'uncovered-gap',
    module: 'frontend/src/components/SessionDetail.tsx',
  },
  {
    component: 'SettingRow',
    group: 'uncovered-gap',
    module: 'frontend/src/components/dialogs/SettingRow.tsx',
  },
  {
    component: 'SettingsDialog',
    group: 'uncovered-gap',
    module: 'frontend/src/components/dialogs/SettingsDialog.tsx',
  },
  {
    component: 'SettingsToc',
    group: 'uncovered-gap',
    module: 'frontend/src/components/dialogs/SettingsToc.tsx',
  },
  {
    component: 'Sidebar',
    group: 'uncovered-gap',
    module: 'frontend/src/components/Sidebar.tsx',
  },
  {
    component: 'StatusDot',
    group: 'uncovered-gap',
    module: 'frontend/src/components/StatusDot.tsx',
  },
  {
    component: 'TargetBranchSwitcher',
    group: 'uncovered-gap',
    module: 'frontend/src/components/TargetBranchSwitcher.tsx',
    note: 'pr-top-bar-action.test.ts vi.mocks it away, so it was never covered there',
  },
  {
    component: 'TicketCard',
    group: 'uncovered-gap',
    module: 'frontend/src/components/TicketCard.tsx',
  },
  {
    component: 'TicketsPanel',
    group: 'uncovered-gap',
    module: 'frontend/src/components/TicketsPanel.tsx',
    note: 'repo-dashboard-tickets-flow.test.ts vi.mocks it away, so it was never covered there',
  },
  {
    component: 'Toolbar',
    group: 'uncovered-gap',
    module: 'frontend/src/components/Toolbar.tsx',
  },
  {
    component: 'TuiMenuItem',
    group: 'uncovered-gap',
    module: 'frontend/src/components/TuiMenuItem.tsx',
  },
  {
    component: 'TuiMenuPanel',
    group: 'uncovered-gap',
    module: 'frontend/src/components/TuiMenuPanel.tsx',
  },
  {
    component: 'UpdateToast',
    group: 'uncovered-gap',
    module: 'frontend/src/components/UpdateToast.tsx',
  },
  {
    component: 'WebhookIntegration',
    group: 'uncovered-gap',
    module:
      'frontend/src/components/dialogs/integrations/WebhookIntegration.tsx',
  },
  {
    component: 'WorkspaceSettingsDialog',
    group: 'uncovered-gap',
    module: 'frontend/src/components/dialogs/WorkspaceSettingsDialog.tsx',
  },
];

/** Specs kept by the sweep. Asserted against `test/e2e/` by the ledger test. */
export const KEPT_SPEC_COUNT = 11;
/** E2E specs added after the #1299 audit baseline. */
export const POST_SWEEP_SPEC_COUNT = 1;

/**
 * Specs the #1299 target audit found navigating to a page that never existed.
 *
 * Every one of the original 69 specs is accounted for: 11 kept, these 57, and
 * `CipherText` — whose target (`/`) did resolve, and which review removed for a
 * different reason. The ledger test pins that arithmetic.
 */
export const NEVER_EXISTING_TARGET_SPECS = 57;

export function countByGroup(
  specs: readonly SweptSpec[] = SWEPT_SPECS
): Record<SweptSpecGroup, number> {
  const counts: Record<SweptSpecGroup, number> = {
    'dead-surface': 0,
    'covered-elsewhere': 0,
    'uncovered-gap': 0,
  };
  for (const spec of specs) counts[spec.group] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Import-graph helpers
// ---------------------------------------------------------------------------

const SOURCE_FILE = /\.tsx?$/;
/** `from './x.js'`, `import('./x.js')`, and bare side-effect `import './x.js'`. */
const IMPORT_SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;
/** `vi.mock('./x.js', ...)` — an edge the runtime never traverses. */
const MOCK_SPECIFIER = /\bvi\.mock\(\s*['"]([^'"]+)['"]/g;

function walk(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (SOURCE_FILE.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every `.ts`/`.tsx` module under `frontend/src`, absolute. */
export function listFrontendModules(): string[] {
  return walk(FRONTEND_SRC, []).sort();
}

function isFile(candidate: string): boolean {
  return (
    SOURCE_FILE.test(candidate) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  );
}

/** Resolve a relative specifier the way the ESM/`.js`-suffix convention does. */
export function resolveSpecifier(
  fromFile: string,
  specifier: string
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base.replace(/\.jsx$/, '.tsx'),
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    base,
  ]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export interface ModuleEdges {
  /** Resolved absolute paths of every source module this file imports. */
  imports: string[];
  /** Resolved absolute paths this file replaces with a `vi.mock` factory. */
  mocks: string[];
}

export function readModuleEdges(file: string): ModuleEdges {
  const source = readFileSync(file, 'utf8');
  const collect = (pattern: RegExp): string[] => {
    pattern.lastIndex = 0;
    const out = new Set<string>();
    for (const match of source.matchAll(pattern)) {
      const resolved = resolveSpecifier(file, match[1] as string);
      if (resolved) out.add(resolved);
    }
    return [...out];
  };
  const mocks = collect(MOCK_SPECIFIER);
  return { imports: collect(IMPORT_SPECIFIER), mocks };
}

/** Repo-relative, POSIX-separated form used everywhere in the ledger. */
export function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split(/[\\/]/).join('/');
}

/** Frontend modules that import `modulePath` (absolute in, repo-relative out). */
export function frontendImportersOf(modulePath: string): string[] {
  const target = resolve(modulePath);
  return listFrontendModules()
    .filter((file) => file !== target)
    .filter((file) => readModuleEdges(file).imports.includes(target))
    .map(repoRelative)
    .sort();
}

/**
 * Frontend modules a vitest file actually pulls in at runtime.
 *
 * `vi.mock` edges are cut: a suite that mocks `DiffViewer` renders a stub, so
 * crediting it with covering `DiffViewer` is exactly the wrong claim the ledger
 * test exists to reject.
 */
export function frontendModulesReachedBy(testFile: string): Set<string> {
  const root = readModuleEdges(testFile);
  const mocked = new Set(root.mocks);
  const reached = new Set<string>();
  const queue = root.imports.filter(
    (file) => file.startsWith(FRONTEND_SRC) && !mocked.has(file)
  );
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const next of readModuleEdges(file).imports) {
      if (!next.startsWith(FRONTEND_SRC)) continue;
      if (mocked.has(next) || reached.has(next)) continue;
      queue.push(next);
    }
  }
  return new Set([...reached].map(repoRelative));
}
