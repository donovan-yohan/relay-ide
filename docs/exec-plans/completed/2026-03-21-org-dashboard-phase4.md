# Jira + Linear Integrations + Status Mapping UI

> **Status**: Complete | **Created**: 2026-03-21
> **Design doc**: `docs/design-docs/2026-03-21-org-dashboard-phase4-design.md`

## Progress

- [x] Task 1: Add Jira/Linear types to server and frontend
- [x] Task 2: Create `server/integration-jira.ts` — Jira REST API client
- [x] Task 3: Create `server/integration-linear.ts` — Linear GraphQL client
- [x] Task 4: Mount Jira/Linear routes in `server/index.ts`
- [x] Task 5: Add frontend API functions for Jira/Linear
- [x] Task 6: Update TicketCard to render provider-native metadata
- [x] Task 7: Update TicketsPanel with Jira/Linear tabs
- [x] Task 8: Update OrgDashboard + StartWorkModal for multi-source tickets
- [x] Task 9: Extend ticket-transitions.ts for Jira/Linear transitions
- [x] Task 10: Create StatusMappingModal.svelte
- [x] Task 11: Build and verify

---

### Task 1: Add Jira/Linear types to server and frontend

**Files:** `server/types.ts`, `frontend/src/lib/types.ts`

**Server types.ts changes:**
- Widen `TicketContext.source` from `'github'` to `'github' | 'jira' | 'linear'`
- Add `JiraIssue` interface:
  ```ts
  export interface JiraIssue {
    key: string;       // e.g. "PROJ-123"
    title: string;     // summary
    url: string;
    status: string;    // status name
    priority: string | null;
    sprint: string | null;
    storyPoints: number | null;
    assignee: string | null;
    updatedAt: string;
    projectKey: string;
    repoPath?: string;  // mapped workspace path (not from Jira)
  }
  ```
- Add `JiraIssuesResponse`: `{ issues: JiraIssue[]; error?: string }`
- Add `LinearIssue` interface:
  ```ts
  export interface LinearIssue {
    id: string;         // Linear issue ID
    identifier: string; // e.g. "TEAM-123"
    title: string;
    url: string;
    state: string;      // state name
    priority: number;   // 0=none, 1=urgent, 2=high, 3=medium, 4=low
    priorityLabel: string;
    cycle: string | null;
    estimate: number | null;
    assignee: string | null;
    updatedAt: string;
    teamId: string;
  }
  ```
- Add `LinearIssuesResponse`: `{ issues: LinearIssue[]; error?: string }`
- Extend `Config.integrations`:
  ```ts
  integrations?: {
    github?: { enableIssues?: boolean };
    jira?: { projectKey?: string; statusMappings?: Record<TransitionState, string> };
    linear?: { teamId?: string; statusMappings?: Record<TransitionState, string> };
  };
  ```
- Add `JiraStatus` and `LinearState` for StatusMappingModal:
  ```ts
  export interface JiraStatus { id: string; name: string; }
  export interface LinearState { id: string; name: string; }
  ```

**Frontend types.ts changes:** Mirror the new types (JiraIssue, LinearIssue, JiraIssuesResponse, LinearIssuesResponse, JiraStatus, LinearState, widen TicketContext.source)

---

### Task 2: Create `server/integration-jira.ts`

**File:** `server/integration-jira.ts` (new)

Follow the `integration-github.ts` pattern:
- Factory function `createIntegrationJiraRouter(deps: { configPath: string }): Router`
- Auth via `process.env.JIRA_API_TOKEN`, `process.env.JIRA_EMAIL`, `process.env.JIRA_BASE_URL`
- 60s in-memory cache
- `GET /issues` — fetch issues assigned to current user via `${JIRA_BASE_URL}/rest/api/3/search`
  - JQL: `assignee=currentUser() AND status != Done ORDER BY updated DESC`
  - Fields: `summary,status,priority,customfield_10016` (story points), sprint
  - Basic auth header: `Authorization: Basic ${btoa(email + ':' + token)}`
  - Map to `JiraIssue[]` — derive `projectKey` from issue key
  - No `repoPath` — Jira issues are cross-workspace
- `GET /statuses` — fetch project statuses via `${JIRA_BASE_URL}/rest/api/3/project/{projectKey}/statuses`
  - Requires `?projectKey=X` query param
  - Returns `JiraStatus[]`
- `GET /configured` — returns `{ configured: boolean }` based on env vars being set
- Error codes: `JIRA_NOT_CONFIGURED`, `JIRA_AUTH_FAILED`, `JIRA_FETCH_FAILED`

---

### Task 3: Create `server/integration-linear.ts`

**File:** `server/integration-linear.ts` (new)

Follow same pattern:
- Factory function `createIntegrationLinearRouter(deps: { configPath: string }): Router`
- Auth via `process.env.LINEAR_API_KEY`
- 60s cache
- `GET /issues` — GraphQL POST to `https://api.linear.app/graphql`
  - Query: `viewer { assignedIssues(filter: { state: { type: { nin: ["completed", "canceled"] } } }, first: 50, orderBy: updatedAt) { nodes { id, identifier, title, url, state { name }, priority, priorityLabel, cycle { name }, estimate, assignee { name }, updatedAt, team { id } } } }`
  - Map to `LinearIssue[]`
- `GET /states` — fetch workflow states via GraphQL
  - Query: `workflowStates(filter: { team: { id: { eq: "$teamId" } } }) { nodes { id, name } }`
  - Requires `?teamId=X` query param
  - Returns `LinearState[]`
- `GET /configured` — returns `{ configured: boolean }`
- Error codes: `LINEAR_NOT_CONFIGURED`, `LINEAR_AUTH_FAILED`, `LINEAR_FETCH_FAILED`

---

### Task 4: Mount Jira/Linear routes in `server/index.ts`

**File:** `server/index.ts`

- Import `createIntegrationJiraRouter` and `createIntegrationLinearRouter`
- Mount at `/integration-jira` and `/integration-linear` behind `requireAuth`
- Follow exact pattern of GitHub integration mounting (lines 273-274)

---

### Task 5: Add frontend API functions

**File:** `frontend/src/lib/api.ts`

Add:
```ts
export async function fetchJiraIssues(): Promise<JiraIssuesResponse> { ... }
export async function fetchLinearIssues(): Promise<LinearIssuesResponse> { ... }
export async function fetchJiraStatuses(projectKey: string): Promise<JiraStatus[]> { ... }
export async function fetchLinearStates(teamId: string): Promise<LinearState[]> { ... }
export async function fetchJiraConfigured(): Promise<boolean> { ... }
export async function fetchLinearConfigured(): Promise<boolean> { ... }
```

Import new types.

---

### Task 6: Update TicketCard for provider-native metadata

**File:** `frontend/src/components/TicketCard.svelte`

- Change `issue` prop type to `GitHubIssue | JiraIssue | LinearIssue`
- Add `source` prop: `'github' | 'jira' | 'linear'`
- Change `onStartWork` type to accept the union
- Add helper to derive `ticketId` per source:
  - GitHub: `GH-${issue.number}`
  - Jira: `issue.key`
  - Linear: `issue.identifier`
- Add metadata rendering per source:
  - **GitHub**: existing (repo chip, number, labels, branch)
  - **Jira**: repo chip (if mapped), key, status badge, priority badge, sprint chip, story points
  - **Linear**: identifier, state badge, priority badge, cycle chip, estimate
- Branch link lookup uses the derived ticketId
- Title link uses `issue.url`

---

### Task 7: Update TicketsPanel with Jira/Linear tabs

**File:** `frontend/src/components/TicketsPanel.svelte`

- Widen `activeTab` to `'github' | 'jira' | 'linear'`
- Add queries for Jira and Linear configured status + issues (each with 60s staleTime)
- Show tab buttons conditionally: GitHub always visible; Jira/Linear only when configured
- Each tab renders its own issue list with appropriate TicketCard source prop
- Count shows per-tab
- Error states per provider (not configured message with env var hints)
- Pass `onStartWork` through for all sources

---

### Task 8: Update OrgDashboard + StartWorkModal for multi-source

**Files:** `frontend/src/components/OrgDashboard.svelte`, `frontend/src/components/StartWorkModal.svelte`

**OrgDashboard.svelte:**
- Widen `startWorkIssue` to `GitHubIssue | JiraIssue | LinearIssue | null`
- Pass through to StartWorkModal with source detection
- TicketsPanel `onStartWork` callback already handles the union

**StartWorkModal.svelte:**
- Change `issue` prop to `GitHubIssue | JiraIssue | LinearIssue`
- Add `source` detection based on type discrimination:
  - Has `number` field → GitHub
  - Has `key` field → Jira
  - Has `identifier` field → Linear
- Derive default branch name per source:
  - GitHub: `gh-${issue.number}`
  - Jira: `${issue.key.toLowerCase()}`
  - Linear: `${issue.identifier.toLowerCase()}`
- Build `ticketContext` with correct source
- Display ticket info adapts per source (key vs number)

---

### Task 9: Extend ticket-transitions.ts

**File:** `server/ticket-transitions.ts`

- Import `loadConfig` and `Config` for reading status mappings
- Add `configPath` to `TicketTransitionsDeps`
- In `transitionOnSessionCreate`:
  - Add `else if (ctx.source === 'jira')` branch: call `POST ${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}/transitions` with the mapped transition ID from config
  - Add `else if (ctx.source === 'linear')` branch: call Linear `issueUpdate` mutation with mapped state ID
- In `checkPrTransitions`:
  - For non-GH ticket IDs, look up source from ticket ID pattern (uppercase 2+ letters + dash + digits = Jira-style; check if Linear API key is set)
  - Apply Jira transitions or Linear state updates accordingly
- Read `config.integrations.jira.statusMappings` and `config.integrations.linear.statusMappings` for the transition/state IDs

---

### Task 10: Create StatusMappingModal.svelte

**File:** `frontend/src/components/StatusMappingModal.svelte` (new)

- Modal UI that maps `TransitionState` values ('in-progress', 'code-review', 'ready-for-qa') to provider-specific statuses
- Props: `provider: 'jira' | 'linear'`, `open`, `onClose`, `onSave`
- On open: fetch available statuses from `/integration-jira/statuses?projectKey=X` or `/integration-linear/states?teamId=X`
- For each TransitionState, show a dropdown of available statuses/states
- Save persists to config via `PATCH /workspaces/settings` or a new config endpoint
- Follow existing modal styling (StartWorkModal pattern)

---

### Task 11: Build and verify

- Run `npm run build` to verify TypeScript compilation
- Run `npm test` to verify no regressions
