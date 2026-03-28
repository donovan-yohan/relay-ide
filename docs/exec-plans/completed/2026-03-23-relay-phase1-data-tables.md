# Relay Phase 1: DataTable Component + Table UI Redesign

> **Status**: Active | **Created**: 2026-03-23 | **Last Updated**: 2026-03-23
> **Design Doc**: `docs/design-docs/2026-03-23-relay-phase1-data-tables-design.md`
> **For Claude:** Use /harness:orchestrate to execute this plan.

## Decision Log

| Date | Phase | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-03-23 | Design | Drop TanStack Table → custom filter chips + sortable columns | TanStack fights two-line rows; filter chips + sort headers are ~200 LOC |
| 2026-03-23 | Design | Monolithic DataTable.svelte with Svelte 5 snippets | 4 consumers, prevents inconsistency recurrence |
| 2026-03-23 | Design | 7-state PR status dot vocabulary | Draft/approved/changes-req/review-req distinction |
| 2026-03-23 | Design | Hybrid column headers + two-line rows | Sortable columns with rich meta in title cell |
| 2026-03-23 | Design | Filter pipeline: filter → search → sort | Standard spreadsheet precedence |
| 2026-03-23 | Design | Stacked cards on mobile (<600px) | Column tables don't work on narrow viewports |
| 2026-03-23 | CEO | Keyboard-driven table navigation | Terminal-native feel |
| 2026-03-23 | CEO | Row grouping by repo in org PR table | Mental model: "how is repo X doing?" |
| 2026-03-23 | CEO | Saved filter presets in config.json | Named views for power users |
| 2026-03-23 | CEO | Tab badge counts | Glance-and-know attention counts |
| 2026-03-23 | Eng | PR1 sorts by role+updated (best-available) | reviewDecision/isDraft unavailable until PR2 |

## Progress

- [x] Task 1: Extract shared utilities (deriveColor, skeleton CSS)
- [x] Task 2: Create StatusDot.svelte component
- [x] Task 3: Create FilterChipBar.svelte component
- [x] Task 4: Create DataTable.svelte (core: scroll, headers, sort, states)
- [x] Task 5: Add keyboard navigation to DataTable
- [x] Task 6: Add row grouping to DataTable
- [x] Task 7: Add mobile card mode to DataTable
- [x] Task 8: Integrate DataTable into OrgDashboard (replace inline PR list)
- [x] Task 9: Integrate DataTable into RepoDashboard (replace inline PR list)
- [x] Task 10: Integrate DataTable into TicketsPanel (wrap ticket lists)
- [x] Task 11: Add saved filter presets (config storage + UI)
- [x] Task 12: Add tab badge counts + action pill onclick + Jira default tab

## Surprises & Discoveries

_None yet — updated during execution by /harness:orchestrate._

## Plan Drift

_None yet — updated when tasks deviate from plan during execution._

---

### Task 1: Extract shared utilities (deriveColor, skeleton CSS)

**Goal:** Extract the `deriveColor()` function duplicated in 3 files and the skeleton `@keyframes` duplicated in 3 files into shared modules.

**Files to create:**
- `frontend/src/lib/colors.ts`

**Files to modify:**
- `frontend/src/components/OrgDashboard.svelte` — remove inline `deriveColor` + `INITIAL_COLORS`, import from `colors.ts`
- `frontend/src/components/TicketCard.svelte` — remove inline `deriveColor` + `INITIAL_COLORS`, import from `colors.ts`
- `frontend/src/components/WorkspaceItem.svelte` — remove inline `deriveColor` + `INITIAL_COLORS`, import from `colors.ts`
- `frontend/src/app.css` — add shared `@keyframes skeleton-pulse` and `.skeleton-line` base class
- `frontend/src/components/OrgDashboard.svelte` — remove local `@keyframes skeleton-pulse` and `.skeleton-line`
- `frontend/src/components/RepoDashboard.svelte` — remove local `@keyframes skeleton-pulse` and `.skeleton-line`
- `frontend/src/components/TicketsPanel.svelte` — remove local `@keyframes skeleton-pulse` and `.skeleton-line`

**Steps:**

1. Create `frontend/src/lib/colors.ts`:
```typescript
const INITIAL_COLORS = [
  '#d97757', '#4ade80', '#60a5fa', '#a78bfa',
  '#f472b6', '#fb923c', '#34d399', '#f87171',
];

export function deriveColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length] ?? '#d97757';
}
```

2. In each of the 3 consumer files, remove the local `INITIAL_COLORS` array and `deriveColor` function. Add `import { deriveColor } from '../lib/colors.js';`.

3. Add to `frontend/src/app.css` (global skeleton animation):
```css
/* Shared skeleton loading animation */
@keyframes skeleton-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.7; }
}
.skeleton-line {
  background: var(--border);
  border-radius: 3px;
  animation: skeleton-pulse 1.4s ease-in-out infinite;
}
```

4. Remove local `@keyframes skeleton-pulse` and `.skeleton-line` definitions from OrgDashboard, RepoDashboard, and TicketsPanel `<style>` blocks. Keep component-specific classes like `.skeleton-title`, `.skeleton-meta`, `.skeleton-activity`.

5. **Verify:** `npm run build` succeeds, `npm test` passes. Visual check that colors and skeleton animations are unchanged.

---

### Task 2: Create StatusDot.svelte component

**Goal:** Replace inline status dot logic (`prStatusDotClass` duplicated in 2 files, inline Jira dot logic in TicketCard) with a shared `StatusDot.svelte` component supporting the full 7-state PR vocabulary + Jira workflow states.

**Files to create:**
- `frontend/src/components/StatusDot.svelte`

**Steps:**

1. Create `StatusDot.svelte`:
```svelte
<script lang="ts">
  let { status, size = 7 }: {
    status: 'draft' | 'open' | 'approved' | 'changes-requested' |
            'review-requested' | 'merged' | 'closed' | 'unknown' |
            'in-progress' | 'code-review' | 'ready-for-qa' | 'unmapped';
    size?: number;
  } = $props();
</script>

<span
  class="status-dot status-dot--{status}"
  style:width="{size}px"
  style:height="{size}px"
  role="img"
  aria-label="{status} status"
></span>

<style>
  .status-dot {
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
  }
  /* PR states */
  .status-dot--draft { background: transparent; border: 1.5px solid var(--border); }
  .status-dot--open { background: var(--status-success); }
  .status-dot--approved { background: var(--status-info); }
  .status-dot--changes-requested { background: var(--status-error); }
  .status-dot--review-requested { background: var(--status-warning); }
  .status-dot--merged { background: var(--status-merged); }
  .status-dot--closed { background: var(--border); border-radius: 2px; }
  .status-dot--unknown { background: var(--border); opacity: 0.5; }
  /* Jira workflow states */
  .status-dot--in-progress { background: var(--status-info); }
  .status-dot--code-review { background: var(--status-warning); }
  .status-dot--ready-for-qa { background: var(--status-success); }
  .status-dot--unmapped { background: var(--border); opacity: 0.6; }
</style>
```

2. Add a helper function to derive PR status from the `PullRequest` type. Create in `frontend/src/lib/pr-status.ts`:
```typescript
import type { PullRequest } from './types.js';

export type PrDotStatus = 'draft' | 'open' | 'approved' | 'changes-requested' |
  'review-requested' | 'merged' | 'closed' | 'unknown';

export function derivePrDotStatus(pr: PullRequest): PrDotStatus {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  // isDraft will be available in Phase 2 (GraphQL)
  if ((pr as any).isDraft) return 'draft';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  // reviewDecision is null from search API — show as 'open' (honest)
  return 'open';
}
```

3. Add a helper for Jira status mapping. In `frontend/src/lib/pr-status.ts`:
```typescript
export type JiraDotStatus = 'in-progress' | 'code-review' | 'ready-for-qa' | 'unmapped';

export function deriveJiraDotStatus(
  issueStatus: string,
  statusMappings?: Record<string, string>
): JiraDotStatus {
  if (!statusMappings) return 'unmapped';
  for (const [workflowState, mappedStatus] of Object.entries(statusMappings)) {
    if (mappedStatus === issueStatus) {
      if (workflowState === 'in-progress') return 'in-progress';
      if (workflowState === 'code-review') return 'code-review';
      if (workflowState === 'ready-for-qa') return 'ready-for-qa';
    }
  }
  return 'unmapped';
}
```

4. **Do NOT integrate into existing components yet** — that happens in Tasks 8-10. This task only creates the new components and helpers.

5. **Verify:** `npm run build` succeeds.

---

### Task 3: Create FilterChipBar.svelte component

**Goal:** Create a reusable filter chip bar component with terminal-native styling.

**Files to create:**
- `frontend/src/components/FilterChipBar.svelte`

**Steps:**

1. Create `FilterChipBar.svelte`:
```svelte
<script lang="ts">
  export interface FilterChip {
    id: string;
    label: string;
    dotStatus?: string;  // StatusDot status for visual indicator
    count?: number;
  }

  let { chips, activeChips, onToggle, onClearAll }: {
    chips: FilterChip[];
    activeChips: string[];
    onToggle: (id: string) => void;
    onClearAll?: () => void;
  } = $props();

  let hasActiveFilters = $derived(activeChips.length > 0);
</script>

<div class="filter-chip-bar" role="group" aria-label="Filters">
  {#each chips as chip (chip.id)}
    <button
      class="filter-chip"
      class:active={activeChips.includes(chip.id)}
      onclick={() => onToggle(chip.id)}
      role="checkbox"
      aria-checked={activeChips.includes(chip.id)}
    >
      {chip.label}
      {#if chip.count !== undefined}
        <span class="chip-count">{chip.count}</span>
      {/if}
    </button>
  {/each}
  {#if hasActiveFilters && onClearAll}
    <button class="filter-chip clear-chip" onclick={onClearAll}>
      Clear
    </button>
  {/if}
</div>
```

2. Add terminal-native CSS: monospace text, `var(--border)` outline, active = `var(--accent)` border. No rounded pills, no colored fills on inactive chips.

3. **Verify:** `npm run build` succeeds.

---

### Task 4: Create DataTable.svelte (core)

**Goal:** Create the monolithic DataTable component with: scroll container, gradient fade, column headers with sort indicators, skeleton loading, empty/filtered-zero/error states.

**Files to create:**
- `frontend/src/components/DataTable.svelte`

**Steps:**

1. Create `DataTable.svelte` implementing the `DataTableProps<T>` interface from the design doc. Key sections:
   - Fixed-height scroll container (`overflow-y: auto`) with `maxHeight` prop
   - Gradient fade `::after` pseudo-element (32px, transparent → `var(--bg)`)
   - Column header row with clickable sort triggers and `▲`/`▼` indicators
   - Skeleton loading state (configurable row count)
   - Error state with retry message
   - Empty state (distinguishes "no data" vs "filters produced zero results")
   - Row rendering via Svelte 5 `{#snippet}` API
   - `aria-sort` on column headers, `role="table"` on container

2. The component uses `{@render row(item)}` for each data row and `{@render mobileCard(item)}` is defined but renders only at <600px (Task 7 adds the responsive switch).

3. Sort state is lifted to the parent — DataTable calls `onSort(columnKey)` when a header is clicked. The parent owns `sortBy` and `sortDir` and passes sorted `rows`.

4. **Verify:** `npm run build` succeeds. Component renders with mock data in isolation.

---

### Task 5: Add keyboard navigation to DataTable

**Goal:** Arrow keys move focus between rows, Enter triggers row action, typing starts search filter.

**Steps:**

1. Add `focusedIndex` state to DataTable. Track via `$state(0)`.

2. Add `onkeydown` handler on the table container:
   - `ArrowDown` → increment `focusedIndex`, clamp to rows length, scroll into view
   - `ArrowUp` → decrement `focusedIndex`, clamp to 0, scroll into view
   - `Enter` → call `onRowAction(rows[focusedIndex])`
   - Any printable character → focus the search input (if `onSearch` prop exists)

3. Add focus ring styling: focused row gets `outline: 2px solid var(--accent)` with `outline-offset: -2px` and `background: var(--surface-hover)`.

4. Implement scroll-into-view: when focused row is outside the scroll container's visible area, call `element.scrollIntoView({ block: 'nearest' })`.

5. Set `tabindex="0"` on the table container to make it focusable.

6. **Verify:** `npm run build` succeeds.

---

### Task 6: Add row grouping to DataTable

**Goal:** When `groupBy` prop is set, rows are grouped by that column's value with collapsible group headers.

**Steps:**

1. Add grouping logic: when `groupBy` is set, derive `groups` from rows by grouping on `row[groupBy]`. Each group has a `key`, `label`, `rows[]`, and `collapsed` state.

2. Render group headers between row groups: `<div class="group-header">` with repo name, count badge, and collapse chevron.

3. `collapsed` state stored per group key in a `Map<string, boolean>` via `$state`.

4. Group headers are not keyboard-focusable (skip in arrow nav). Clicking the header toggles collapse.

5. Sort applies within groups (not across groups). Groups themselves are ordered alphabetically.

6. **Verify:** `npm run build` succeeds.

---

### Task 7: Add mobile card mode to DataTable

**Goal:** Below 600px viewport width, switch from column layout to stacked cards.

**Steps:**

1. Add a `mobileBreakpoint` state derived from `window.matchMedia('(max-width: 600px)')`.

2. When in mobile mode:
   - Hide column headers
   - Render `{@render mobileCard(item)}` instead of `{@render row(item)}`
   - Cards have `border-bottom: 1px solid var(--border)`, touch targets ≥44px

3. Add media query CSS for `.data-table--mobile` class.

4. **Verify:** `npm run build` succeeds.

---

### Task 8: Integrate DataTable into OrgDashboard

**Goal:** Replace the inline PR list in OrgDashboard with the DataTable component + FilterChipBar + StatusDot. This is the largest integration task.

**Files to modify:**
- `frontend/src/components/OrgDashboard.svelte`

**Steps:**

1. Remove inline `prStatusDotClass`, `INITIAL_COLORS`, `deriveColor` (already extracted in Task 1). Remove the `<select>` filter dropdowns and inline PR list rendering.

2. Add imports: `DataTable`, `FilterChipBar`, `StatusDot`, `derivePrDotStatus`, `deriveColor` from shared modules.

3. Define column configuration:
```typescript
const prColumns = [
  { key: 'status', label: 'St', sortable: false, width: '36px' },
  { key: 'title', label: 'Title', sortable: true },
  { key: 'repo', label: 'Repo', sortable: true, width: '100px' },
  { key: 'role', label: 'Role', sortable: true, width: '60px' },
  { key: 'age', label: 'Age', sortable: true, width: '50px' },
  { key: 'action', label: 'Act', sortable: false, width: '40px' },
];
```

4. Add filter chip state:
```typescript
const statusChips: FilterChip[] = [
  { id: 'open', label: 'Open' },
  { id: 'draft', label: 'Draft' },
  { id: 'changes-requested', label: 'Changes Req' },
  { id: 'review-requested', label: 'Review Req' },
];
let activeStatusChips = $state<string[]>([]);
let activeRepoChips = $state<string[]>([]);
let activeRoleChips = $state<string[]>([]);
let searchQuery = $state('');
```

5. Implement filter pipeline: `filter chips → search → sort` as `$derived`:
```typescript
let processedPrs = $derived.by(() => {
  let prs = allPrs;
  // Filter by status chips
  if (activeStatusChips.length > 0) {
    prs = prs.filter(pr => activeStatusChips.includes(derivePrDotStatus(pr)));
  }
  // Filter by repo chips
  if (activeRepoChips.length > 0) {
    prs = prs.filter(pr => activeRepoChips.includes(pr.repoName ?? ''));
  }
  // Filter by role chips
  if (activeRoleChips.length > 0) {
    prs = prs.filter(pr => activeRoleChips.includes(pr.role));
  }
  // Search
  const q = searchQuery.toLowerCase().trim();
  if (q) {
    prs = prs.filter(pr =>
      pr.title.toLowerCase().includes(q) ||
      String(pr.number).includes(q) ||
      pr.headRefName.toLowerCase().includes(q)
    );
  }
  // Sort (best-available: role → updated)
  prs = [...prs].sort((a, b) => {
    // Default: reviewers first, then by updated
    const roleOrder = { reviewer: 0, author: 1 };
    const roleDiff = (roleOrder[a.role] ?? 1) - (roleOrder[b.role] ?? 1);
    if (roleDiff !== 0) return roleDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  return prs;
});
```

6. Replace template with `<FilterChipBar>` + `<DataTable>` using snippets for row and mobileCard rendering. Each row renders `<StatusDot>`, title (two-line with PR number + role on second line), repo chip, role label, relative time, and action pill.

7. Wire action pill `onclick` to `onOpenWorkspace(pr.repoPath)` — resolves the "inert button" issue.

8. Add `groupBy="repoName"` to the DataTable for collapsible repo groups.

9. **Verify:** `npm run build` succeeds. Visual check that OrgDashboard renders PRs in the new table format.

---

### Task 9: Integrate DataTable into RepoDashboard

**Goal:** Replace the inline PR list in RepoDashboard with DataTable. Keep activity feed as-is (compact log, not DataTable).

**Files to modify:**
- `frontend/src/components/RepoDashboard.svelte`

**Steps:**

1. Remove inline `prStatusDotClass` function (duplicated from OrgDashboard). Remove the conditional search input and inline PR list.

2. Add imports: `DataTable`, `StatusDot`, `derivePrDotStatus`.

3. Define simpler column configuration (no repo column — single workspace):
```typescript
const prColumns = [
  { key: 'status', label: 'St', sortable: false, width: '36px' },
  { key: 'title', label: 'Title', sortable: true },
  { key: 'role', label: 'Role', sortable: true, width: '60px' },
  { key: 'age', label: 'Age', sortable: true, width: '50px' },
  { key: 'action', label: 'Act', sortable: false, width: '80px' },
];
```

4. Add sort and search state. No filter chips (single repo = no repo filter needed, status filter less useful for small lists). Search always visible (remove the `>5` threshold).

5. Replace PR list with `<DataTable>`. Use snippets for row rendering. Action column keeps the existing `+` button, conflict pill, merge link, and action pill.

6. Keep the existing scroll container pattern for the activity feed — activity is NOT wrapped in DataTable.

7. Remove local skeleton and dot CSS that's now in shared components.

8. **Verify:** `npm run build` succeeds.

---

### Task 10: Integrate DataTable into TicketsPanel

**Goal:** Wrap both GitHub Issues and Jira ticket lists in DataTable. Switch Jira to default tab. Use StatusDot for Jira workflow colors.

**Files to modify:**
- `frontend/src/components/TicketsPanel.svelte`
- `frontend/src/components/TicketCard.svelte`

**Steps:**

1. Change default tab from `'github'` to `'jira'`:
```typescript
let activeTab = $state<'github' | 'jira'>('jira');
```

2. Define ticket columns (simpler than PR columns):
```typescript
const ticketColumns = [
  { key: 'status', label: 'St', sortable: false, width: '36px' },
  { key: 'title', label: 'Title', sortable: true },
  { key: 'meta', label: '', sortable: false },
  { key: 'action', label: '', sortable: false, width: '100px' },
];
```

3. Wrap each tab's content in `<DataTable>`. Row snippets delegate to `<TicketCard>` (existing component, minimally modified).

4. In `TicketCard.svelte`: replace inline dot logic with `<StatusDot>`. For Jira, use `deriveJiraDotStatus()` with the StatusMappingModal's mappings. Remove inline `deriveColor` (already extracted in Task 1).

5. Replace "Enjoy the quiet." with "No assigned tickets."

6. Remove local skeleton CSS (now in app.css).

7. **Verify:** `npm run build` succeeds. Jira tab is default.

---

### Task 11: Add saved filter presets

**Goal:** Filter presets stored in config.json with UI for save/switch/delete.

**Files to modify:**
- `frontend/src/lib/types.ts` — add `FilterPreset` interface
- `frontend/src/lib/api.ts` — add preset CRUD endpoints
- `frontend/src/components/OrgDashboard.svelte` — add preset dropdown
- `server/types.ts` — add `filterPresets` to Config
- `server/config.ts` — add default presets, load/save logic
- `server/index.ts` — add preset API routes

**Steps:**

1. Add `FilterPreset` type to `frontend/src/lib/types.ts`:
```typescript
export interface FilterPreset {
  name: string;
  builtIn?: boolean;
  filters: { status?: string[]; repo?: string[]; role?: string[] };
  sort: { column: string; direction: 'asc' | 'desc' };
}
```

2. Add `filterPresets?: FilterPreset[]` to `Config` in `server/types.ts`.

3. Add default presets in `server/config.ts`:
```typescript
const DEFAULT_PRESETS: FilterPreset[] = [
  { name: 'Needs Attention', builtIn: true, filters: {}, sort: { column: 'role', direction: 'asc' } },
  { name: 'All PRs', builtIn: true, filters: {}, sort: { column: 'updated', direction: 'desc' } },
];
```

4. Add API routes: `GET /presets`, `POST /presets`, `DELETE /presets/:name`.

5. In OrgDashboard, add a preset dropdown next to the filter chips. Selecting a preset applies its filters and sort. "Save current view..." opens a name prompt. User presets show a delete option in a context menu.

6. **Verify:** `npm run build` succeeds, `npm test` passes. Presets persist across page refresh.

---

### Task 12: Add tab badge counts + remaining polish

**Goal:** Tab badges show attention counts. Final cleanup.

**Files to modify:**
- `frontend/src/components/OrgDashboard.svelte` — add count badges to tab headers

**Steps:**

1. Compute attention counts from PR data:
```typescript
let prAttentionCount = $derived(
  allPrs.filter(pr =>
    pr.state === 'OPEN' && (
      pr.reviewDecision === 'CHANGES_REQUESTED' ||
      pr.role === 'reviewer'
    )
  ).length
);
```

2. Compute ticket count from active issues.

3. Render count badges next to tab labels: `PRs (3)`, `Tickets (5)`. Badge styled as inline monospace count, `var(--text-muted)` color.

4. **Final cleanup:**
   - Remove any remaining local `@keyframes skeleton-pulse` in components
   - Remove any remaining inline `.dot` CSS that's now in StatusDot
   - Ensure all `deriveColor` imports point to `../lib/colors.js`

5. **Verify:** `npm run build` succeeds, `npm test` passes. Full visual check of all 4 table surfaces.

---

## Outcomes & Retrospective

_Filled by /harness:complete when work is done._

**What worked:**
-

**What didn't:**
-

**Learnings to codify:**
-
