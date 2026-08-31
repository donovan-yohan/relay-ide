// @vitest-environment happy-dom
//
// #1298: `AddWorkspaceDialog` is live code with three importers (`App.tsx`,
// `lib/actions/definitions/workspace.ts`, `lib/bulk-add-lanes.ts`) and had ZERO
// automated coverage — its only spec, `test/e2e/components/AddWorkspaceDialog
// .spec.ts`, navigated to `/test-add-workspace-dialog.html`, a fixture page
// that never existed and was never registered in `includeE2eFixtures`, so it
// had never executed (swept in #1299).
//
// `resolveBulkAddLanes` is already unit-covered in `test/lib/bulk-add-lanes
// .test.ts`. What was untested is the CALL SITE: the dialog turning that
// outcome into (a) whether `onWorkspacesAdded` fires at all, (b) WHICH paths it
// hands over, and (c) whether the dialog closes or keeps the failure on screen.
// The #1287-slice-2 review found that split is the whole point — `App.tsx`
// treats the callback as "refresh the read models" and the argument as "reveal
// this lane", so `registeredPaths > 0, laneReadyPaths === 0` (every resolved
// lane archived) must still call back, with an EMPTY array. A test that only
// exercises the pure function cannot catch that regression.

import React, { act } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  addWorkspacesBulk: vi.fn(),
  browseFsDirectory: vi.fn(),
  createWorkspaceFolder: vi.fn(),
  fetchHubNodes: vi.fn(),
  createTerminalSession: vi.fn(),
}));

vi.mock('../../frontend/src/lib/api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../frontend/src/lib/api.js')>();
  return {
    ...actual,
    addWorkspacesBulk: mocks.addWorkspacesBulk,
    browseFsDirectory: mocks.browseFsDirectory,
    createWorkspaceFolder: mocks.createWorkspaceFolder,
    fetchHubNodes: mocks.fetchHubNodes,
  };
});

// The remote lane never touches /workspaces: it opens a terminal on the node.
// Stubbing at this seam keeps the rest of the dialog real.
vi.mock('../../frontend/src/lib/session-utils.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../frontend/src/lib/session-utils.js')
  >();
  return { ...actual, createTerminalSession: mocks.createTerminalSession };
});

const AddWorkspaceDialog = (
  await import('../../frontend/src/components/dialogs/AddWorkspaceDialog.js')
).default;
type AddWorkspaceDialogHandle = import(
  '../../frontend/src/components/dialogs/AddWorkspaceDialog.js'
).AddWorkspaceDialogHandle;

const REPO = '/home/me/code/relay-ide';
const NOTES = '/home/me/code/notes';

function browseResponse() {
  return {
    resolved: '/home/me/code',
    entries: [
      {
        name: 'relay-ide',
        path: REPO,
        isGitRepo: true,
        hasChildren: false,
      },
      { name: 'notes', path: NOTES, isGitRepo: false, hasChildren: false },
    ],
    truncated: false,
    total: 2,
  };
}

function addedEntry(path: string, name: string) {
  return { path, name, isGitRepo: true, defaultBranch: 'nightly' };
}

function lane(
  path: string,
  overrides: { name?: string; created?: boolean; archived?: boolean } = {}
) {
  return {
    path,
    workspaceId: `ws:project%3A${path.length}`,
    name: overrides.name ?? 'relay-ide',
    created: overrides.created ?? true,
    archived: overrides.archived ?? false,
  };
}

function hubNode(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'node-mac',
    displayName: 'dev mac',
    hostname: 'dev-mac.local',
    homeDir: '/Users/me',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '9.9.9',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'reverse-link', status: 'connected' },
    trust: { state: 'trusted', level: 'standard', warning: '' },
    credentialState: 'active',
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 11, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        git: 'available',
        worktrees: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      terminalBackends: { 'relay-pty': 'available' },
      agents: { claude: 'available' },
      serviceManager: 'launchd',
      wsl: false,
      sessionResume: 'canonical-emulator',
    },
    createdAt: '2026-01-02T03:00:00.000Z',
    pairedAt: '2026-01-02T03:00:00.000Z',
    lastSeenAt: '2026-01-02T03:04:30.000Z',
    credentialId: 'cred-1',
    ...overrides,
  } as HubNodeSummary;
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let onWorkspacesAdded: Mock<(paths: string[]) => void>;
let dialogRef: React.RefObject<AddWorkspaceDialogHandle | null>;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAndOpen(): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(AddWorkspaceDialog, {
          ref: dialogRef,
          onWorkspacesAdded,
        })
      )
    );
  });
  await act(async () => {
    dialogRef.current?.open();
  });
  await flush();
}

function dialogEl(): HTMLDialogElement {
  const el = container.querySelector('dialog');
  if (!el) throw new Error('dialog not rendered');
  return el as HTMLDialogElement;
}

function text(selector: string): string {
  return Array.from(container.querySelectorAll(selector))
    .map((el) => el.textContent ?? '')
    .join(' | ');
}

function treeRow(name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll('.tree-row')).find(
    (el) => el.querySelector('.node-name')?.textContent === name
  );
  if (!row) throw new Error(`no browser row named ${name}`);
  return row as HTMLElement;
}

/** Click the browser row whose `.node-name` matches. Rows with no children
 *  select on click (see `FileBrowser`'s `TreeRow`), which is the real user
 *  gesture that populates `selectedPaths`. */
async function selectPath(name: string): Promise<void> {
  const row = treeRow(name);
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

/** Pick a host from `#aw-node`, which is what flips the dialog to remote mode. */
async function selectHost(nodeId: string): Promise<void> {
  const select = container.querySelector('#aw-node') as HTMLSelectElement;
  if (!select) throw new Error('host picker not rendered');
  await act(async () => {
    select.value = nodeId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

/** Type into the controlled cwd input the way React's onChange will see it. */
async function typeRemoteCwd(cwd: string): Promise<void> {
  const input = container.querySelector('#aw-remote-cwd') as HTMLInputElement;
  if (!input) throw new Error('remote cwd input not rendered');
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  if (!setValue) throw new Error('no native value setter');
  await act(async () => {
    setValue.call(input, cwd);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function typeFolderName(name: string): Promise<HTMLInputElement> {
  const input = container.querySelector(
    '#new-folder-name'
  ) as HTMLInputElement;
  if (!input) throw new Error('new folder editor not rendered');
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  if (!setValue) throw new Error('no native value setter');
  await act(async () => {
    setValue.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
  return input;
}

function submitButton(): HTMLButtonElement {
  const btn = container.querySelector(
    '.add-workspace-footer-actions .tui-btn--primary'
  );
  if (!btn) throw new Error('submit button not rendered');
  return btn as HTMLButtonElement;
}

async function submit(): Promise<void> {
  await act(async () => {
    submitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  mocks.addWorkspacesBulk.mockReset();
  mocks.browseFsDirectory.mockReset();
  mocks.createWorkspaceFolder.mockReset();
  mocks.fetchHubNodes.mockReset();
  mocks.createTerminalSession.mockReset();
  mocks.browseFsDirectory.mockResolvedValue(browseResponse());
  mocks.fetchHubNodes.mockResolvedValue([]);
  window.localStorage.clear();
  onWorkspacesAdded = vi.fn();
  dialogRef = React.createRef<AddWorkspaceDialogHandle>();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

describe('<AddWorkspaceDialog /> render (#1298)', () => {
  it('opens onto the local host picker, the folder browser, and a disabled submit', async () => {
    await mountAndOpen();

    expect(dialogEl().open).toBe(true);
    expect(dialogEl().getAttribute('aria-label')).toBe('add project');

    const host = container.querySelector('#aw-node') as HTMLSelectElement;
    expect(host).toBeTruthy();
    expect(host.value).toBe('local');
    expect(text('#aw-node option')).toContain('this host');

    // Local host => folder browser, not the remote-cwd input.
    expect(mocks.browseFsDirectory).toHaveBeenCalled();
    expect(container.querySelectorAll('.tree-row')).toHaveLength(2);
    expect(container.querySelector('#aw-remote-cwd')).toBeNull();

    // Nothing picked yet: submit is inert and the count stays blank.
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toContain('add project');
    expect(text('.add-workspace-selected-count').trim()).toBe('');
  });

  it('creates a root folder inline, refreshes it, and selects it on Enter', async () => {
    const NEW_PROJECT = '/home/me/code/new-project';
    mocks.browseFsDirectory
      .mockResolvedValueOnce(browseResponse())
      .mockResolvedValueOnce({
        ...browseResponse(),
        entries: [
          ...browseResponse().entries,
          {
            name: 'new-project',
            path: NEW_PROJECT,
            isGitRepo: false,
            hasChildren: false,
          },
        ],
        total: 3,
      });
    mocks.createWorkspaceFolder.mockResolvedValue({
      name: 'new-project',
      path: NEW_PROJECT,
      isGitRepo: false,
      hasChildren: false,
      isDirectory: true,
    });
    await mountAndOpen();

    const newFolder = container.querySelector(
      '.new-root-folder-btn'
    ) as HTMLButtonElement;
    expect(newFolder.disabled).toBe(false);
    await act(async () => {
      newFolder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = await typeFolderName('  new-project  ');
    expect(document.activeElement).toBe(input);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();

    expect(mocks.createWorkspaceFolder).toHaveBeenCalledWith(
      '/home/me/code',
      '  new-project  '
    );
    expect(mocks.browseFsDirectory).toHaveBeenCalledTimes(2);
    expect(text('.tree-row.selected .node-name')).toContain('new-project');
    expect(text('.add-workspace-selected-count')).toContain('1 selected');
    expect(container.querySelector('#new-folder-name')).toBeNull();
  });

  it('targets a directory with its accessible action and Escape cancels the inline editor', async () => {
    await mountAndOpen();

    const action = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.new-folder-btn')
    ).find((button) => button.getAttribute('aria-label') === 'new folder in notes');
    expect(action).toBeTruthy();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = await typeFolderName('scratch');
    expect(text('.folder-create-label')).toContain(NOTES);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();

    expect(container.querySelector('#new-folder-name')).toBeNull();
    expect(mocks.createWorkspaceFolder).not.toHaveBeenCalled();
  });

  it('keeps a create error in the inline editor for correction', async () => {
    mocks.createWorkspaceFolder.mockRejectedValue(new Error('Folder already exists'));
    await mountAndOpen();
    const newFolder = container.querySelector(
      '.new-root-folder-btn'
    ) as HTMLButtonElement;
    await act(async () => {
      newFolder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = await typeFolderName('new-project');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();

    expect(text('.folder-create-error')).toContain('Folder already exists');
    expect((container.querySelector('#new-folder-name') as HTMLInputElement).value).toBe(
      'new-project'
    );
  });

  it('preserves expanded descendants and their selection when a root refresh adds a folder', async () => {
    const PROJECTS = '/home/me/code/projects';
    const NESTED = `${PROJECTS}/nested`;
    const LEAF = `${NESTED}/leaf`;
    const CREATED = '/home/me/code/new-project';
    mocks.browseFsDirectory
      .mockResolvedValueOnce({
        resolved: '/home/me/code',
        entries: [
          { name: 'projects', path: PROJECTS, isGitRepo: false, hasChildren: true },
        ],
        truncated: false,
        total: 1,
      })
      .mockResolvedValueOnce({
        resolved: PROJECTS,
        entries: [
          { name: 'nested', path: NESTED, isGitRepo: false, hasChildren: true },
        ],
        truncated: false,
        total: 1,
      })
      .mockResolvedValueOnce({
        resolved: NESTED,
        entries: [
          { name: 'leaf', path: LEAF, isGitRepo: false, hasChildren: false },
        ],
        truncated: false,
        total: 1,
      })
      .mockResolvedValueOnce({
        resolved: '/home/me/code',
        entries: [
          { name: 'new-project', path: CREATED, isGitRepo: false, hasChildren: false },
          { name: 'projects', path: PROJECTS, isGitRepo: false, hasChildren: true },
        ],
        truncated: false,
        total: 2,
      });
    mocks.createWorkspaceFolder.mockResolvedValue({
      name: 'new-project',
      path: CREATED,
      isGitRepo: false,
      hasChildren: false,
      isDirectory: true,
    });
    await mountAndOpen();
    await selectPath('projects');
    await selectPath('nested');
    await selectPath('leaf');

    const newFolder = container.querySelector(
      '.new-root-folder-btn'
    ) as HTMLButtonElement;
    await act(async () => {
      newFolder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = await typeFolderName('new-project');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();

    expect(treeRow('projects').getAttribute('aria-expanded')).toBe('true');
    expect(treeRow('nested').getAttribute('aria-expanded')).toBe('true');
    expect(treeRow('leaf').className).toContain('selected');
    expect(treeRow('new-project').className).toContain('selected');
    expect(text('.add-workspace-selected-count')).toContain('2 selected');
  });

  it('merges a created folder omitted by a truncated browse response and keeps the notice accurate', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      name: `dir-${String(index).padStart(3, '0')}`,
      path: `/home/me/code/dir-${String(index).padStart(3, '0')}`,
      isGitRepo: false,
      hasChildren: false,
    }));
    const CREATED = '/home/me/code/z-project';
    mocks.browseFsDirectory
      .mockResolvedValueOnce({
        resolved: '/home/me/code',
        entries,
        truncated: true,
        total: 101,
      })
      .mockResolvedValueOnce({
        resolved: '/home/me/code',
        entries,
        truncated: true,
        total: 102,
      });
    mocks.createWorkspaceFolder.mockResolvedValue({
      name: 'z-project',
      path: CREATED,
      isGitRepo: false,
      hasChildren: false,
      isDirectory: true,
    });
    await mountAndOpen();
    const newFolder = container.querySelector(
      '.new-root-folder-btn'
    ) as HTMLButtonElement;
    await act(async () => {
      newFolder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = await typeFolderName('z-project');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();

    expect(container.querySelectorAll('.tree-row')).toHaveLength(101);
    expect(treeRow('z-project').className).toContain('selected');
    expect(text('.truncated-notice')).toContain('Showing 101 of 102');
    expect(
      Array.from(container.querySelectorAll('.node-name')).at(-1)?.textContent
    ).toBe('z-project');
  });

  it('enables submit and counts the selection once a folder is picked', async () => {
    await mountAndOpen();
    await selectPath('relay-ide');

    expect(submitButton().disabled).toBe(false);
    expect(text('.add-workspace-selected-count')).toContain('1 selected');

    await selectPath('notes');
    expect(text('.add-workspace-selected-count')).toContain('2 selected');
    expect(submitButton().textContent).toContain('add projects');
  });

  it('lists reachable remote hosts and disables the ones that cannot take a shell', async () => {
    mocks.fetchHubNodes.mockResolvedValue([
      hubNode(),
      hubNode({
        nodeId: 'node-offline',
        displayName: 'old box',
        status: 'offline',
      }),
    ]);
    await mountAndOpen();

    const options = Array.from(
      container.querySelectorAll<HTMLOptionElement>('#aw-node option')
    );
    expect(options.map((o) => o.value)).toEqual([
      'local',
      'node-mac',
      'node-offline',
    ]);
    expect(options[1]!.disabled).toBe(false);
    expect(options[2]!.disabled).toBe(true);
    expect(options[2]!.textContent).toContain('node is offline');
    // The picker's fetch also warms the shared `hub-nodes` cache.
    expect(queryClient.getQueryData(['hub-nodes'])).toHaveLength(2);
    expect(container.querySelector('.add-workspace-error-msg')).toBeNull();
  });

  it('degrades to local-only with a named reason when the node list fails', async () => {
    mocks.fetchHubNodes.mockRejectedValue(new Error('hub unreachable'));
    await mountAndOpen();

    expect(text('.add-workspace-error-msg')).toContain(
      'could not list remote hosts'
    );
    // Degraded, not broken: the local add path is still fully usable.
    expect(
      Array.from(container.querySelectorAll('#aw-node option'))
    ).toHaveLength(1);
    await selectPath('relay-ide');
    expect(submitButton().disabled).toBe(false);
  });
});

describe('<AddWorkspaceDialog /> add-project outcomes (#1294/#1287)', () => {
  it('adds a picked path, reveals its lane, and closes', async () => {
    mocks.addWorkspacesBulk.mockResolvedValue({
      added: [addedEntry(REPO, 'relay-ide')],
      errors: [],
      workspaces: [lane(REPO)],
    });
    await mountAndOpen();
    await selectPath('relay-ide');
    await submit();

    expect(mocks.addWorkspacesBulk).toHaveBeenCalledWith([REPO]);
    expect(onWorkspacesAdded).toHaveBeenCalledTimes(1);
    expect(onWorkspacesAdded).toHaveBeenCalledWith([REPO]);
    expect(dialogEl().open).toBe(false);
    expect(container.querySelector('.add-workspace-error-msg')).toBeNull();
  });

  it('falls back to the added paths when the hub omits the workspaces field', async () => {
    // Pre-#1287 hub: no `workspaces` array at all. The add still has to reveal
    // something or the new project is invisible on an older hub.
    mocks.addWorkspacesBulk.mockResolvedValue({
      added: [addedEntry(REPO, 'relay-ide')],
      errors: [],
    });
    await mountAndOpen();
    await selectPath('relay-ide');
    await submit();

    expect(onWorkspacesAdded).toHaveBeenCalledWith([REPO]);
    expect(dialogEl().open).toBe(false);
  });

  it('re-adding an existing path surfaces the existing lane instead of only "Already exists" (#1294)', async () => {
    // The hub rejects the duplicate (`added: []`) but still resolves the lane
    // it already has. Idempotence means the second add reveals the SAME lane —
    // treating "Already exists" as a plain failure is the #1294 bug.
    mocks.addWorkspacesBulk.mockResolvedValue({
      added: [],
      errors: [{ path: REPO, error: 'Already exists' }],
      workspaces: [lane(REPO, { created: false })],
    });
    await mountAndOpen();
    await selectPath('relay-ide');
    await submit();

    expect(onWorkspacesAdded).toHaveBeenCalledTimes(1);
    expect(onWorkspacesAdded).toHaveBeenCalledWith([REPO]);
    // The notice is reported, but as a partial result — not the blocking error
    // path, and never instead of the reveal.
    expect(text('.add-workspace-partial-errors')).toContain('Already exists');
    expect(dialogEl().open).toBe(true);
    expect(submitButton().disabled).toBe(false);
  });

  it('an archived-only add refreshes without revealing, and names the archive', async () => {
    // registeredPaths=[REPO], laneReadyPaths=[] — the hub DID append the path
    // to `config.repos`, so the client still owes a refresh, but
    // `GET /hub/ia/workspaces` hides archived rows so there is nothing to
    // select. Callback fires with an EMPTY array: refresh yes, reveal no.
    mocks.addWorkspacesBulk.mockResolvedValue({
      added: [addedEntry(REPO, 'relay-ide')],
      errors: [],
      workspaces: [
        lane(REPO, { name: 'Retired lane', created: false, archived: true }),
      ],
    });
    await mountAndOpen();
    await selectPath('relay-ide');
    await submit();

    expect(onWorkspacesAdded).toHaveBeenCalledTimes(1);
    expect(onWorkspacesAdded).toHaveBeenCalledWith([]);
    const shown = text('.add-workspace-error-msg');
    expect(shown).toContain('archived');
    expect(shown).toContain('Retired lane');
    expect(shown).toContain(REPO);
    // Blocking outcome: the dialog stays up so the operator sees why.
    expect(dialogEl().open).toBe(true);
  });

  it('does not fire the refresh callback when nothing registered and no lane resolved', async () => {
    // The other side of the registeredPaths/laneReadyPaths split: a pure
    // failure must NOT trigger a read-model refresh.
    mocks.addWorkspacesBulk.mockResolvedValue({
      added: [],
      errors: [{ path: REPO, error: 'ENOENT: no such directory' }],
      workspaces: [],
    });
    await mountAndOpen();
    await selectPath('relay-ide');
    await submit();

    expect(onWorkspacesAdded).not.toHaveBeenCalled();
    expect(text('.add-workspace-error-msg')).toContain(
      'ENOENT: no such directory'
    );
    expect(dialogEl().open).toBe(true);
  });

  it('keeps the resolved lane on a partial add and lists only the failures', async () => {
    mocks.addWorkspacesBulk.mockResolvedValue({
      added: [addedEntry(REPO, 'relay-ide')],
      errors: [{ path: NOTES, error: 'Permission denied' }],
      workspaces: [lane(REPO)],
    });
    await mountAndOpen();
    await selectPath('relay-ide');
    await selectPath('notes');
    await submit();

    expect(mocks.addWorkspacesBulk).toHaveBeenCalledWith([REPO, NOTES]);
    expect(onWorkspacesAdded).toHaveBeenCalledWith([REPO]);
    const partial = text('.add-workspace-partial-errors');
    expect(partial).toContain(NOTES);
    expect(partial).toContain('Permission denied');
    // Partial success keeps the dialog open so the failure is dismissible.
    expect(dialogEl().open).toBe(true);
  });

  it('surfaces a thrown request error and leaves the dialog retryable', async () => {
    mocks.addWorkspacesBulk.mockRejectedValue(new Error('hub said 500'));
    await mountAndOpen();
    await selectPath('relay-ide');
    await submit();

    expect(onWorkspacesAdded).not.toHaveBeenCalled();
    expect(text('.add-workspace-error-msg')).toContain(
      'failed to add workspaces: hub said 500'
    );
    expect(dialogEl().open).toBe(true);
    // `submitting` must have been released or the retry is impossible.
    expect(submitButton().disabled).toBe(false);
  });

  it('clears the previous failure and selection when reopened', async () => {
    mocks.addWorkspacesBulk.mockRejectedValue(new Error('hub said 500'));
    await mountAndOpen();
    await selectPath('relay-ide');
    await submit();
    expect(text('.add-workspace-error-msg')).toContain('hub said 500');

    await act(async () => {
      dialogRef.current?.close();
    });
    await act(async () => {
      dialogRef.current?.open();
    });
    await flush();

    expect(container.querySelector('.add-workspace-error-msg')).toBeNull();
    expect(container.querySelector('.add-workspace-partial-errors')).toBeNull();
    expect(submitButton().disabled).toBe(true);
    expect(text('.add-workspace-selected-count').trim()).toBe('');
  });
});

// #1299 review follow-up: the first pass covered only the `!isRemote` half of
// `handleSubmit`. The remote branch has its own submit gate, its own call, and
// its own error copy, and it was left with exactly the zero-behavioural-coverage
// status #1298 was raised to close.
describe('<AddWorkspaceDialog /> remote lane (#1298)', () => {
  beforeEach(() => {
    mocks.fetchHubNodes.mockResolvedValue([hubNode()]);
  });

  it('swaps the folder browser for a cwd input prefilled from the node home', async () => {
    await mountAndOpen();
    await selectHost('node-mac');

    expect(container.querySelector('.tree-row')).toBeNull();
    const cwd = container.querySelector('#aw-remote-cwd') as HTMLInputElement;
    expect(cwd).toBeTruthy();
    expect(cwd.value).toBe('/Users/me');
    expect(text('.add-workspace-dialog-label')).toContain('dev mac');
    expect(submitButton().disabled).toBe(false);
  });

  it('blocks submit until the cwd is non-empty', async () => {
    await mountAndOpen();
    await selectHost('node-mac');
    await typeRemoteCwd('   ');

    expect(submitButton().disabled).toBe(true);
    await submit();
    expect(mocks.createTerminalSession).not.toHaveBeenCalled();
  });

  it('creates the remote terminal from the typed cwd, remembers it, and closes', async () => {
    mocks.createTerminalSession.mockResolvedValue({
      session: { id: 'node-mac:remote-1' },
      error: null,
    });
    await mountAndOpen();
    await selectHost('node-mac');
    await typeRemoteCwd('/Users/me/src/relay-ide');
    await submit();

    expect(mocks.createTerminalSession).toHaveBeenCalledTimes(1);
    expect(mocks.createTerminalSession.mock.calls[0]?.[0]).toMatchObject({
      nodeId: 'node-mac',
      mode: 'pty',
      cwd: '/Users/me/src/relay-ide',
      sessionLane: 'remote-cwd',
    });
    // Remote is not a project: no registry write, so no refresh callback.
    expect(mocks.addWorkspacesBulk).not.toHaveBeenCalled();
    expect(onWorkspacesAdded).not.toHaveBeenCalled();
    expect(dialogEl().open).toBe(false);
    expect(
      window.localStorage.getItem('relay-ide.remote-node-cwd.node-mac')
    ).toBe('/Users/me/src/relay-ide');
  });

  it('surfaces the distinct remote failure copy and stays retryable', async () => {
    mocks.createTerminalSession.mockRejectedValue(new Error('node said 500'));
    await mountAndOpen();
    await selectHost('node-mac');
    await typeRemoteCwd('/Users/me/src/relay-ide');
    await submit();

    // Not "failed to add workspaces" — the remote branch has its own message,
    // and a wrong one sends the operator to the project registry for a node
    // problem.
    expect(text('.add-workspace-error-msg')).toContain(
      'failed to create remote terminal: node said 500'
    );
    expect(dialogEl().open).toBe(true);
    expect(submitButton().disabled).toBe(false);
    expect(onWorkspacesAdded).not.toHaveBeenCalled();
  });

  it('reports a rejected session create without closing', async () => {
    mocks.createTerminalSession.mockResolvedValue({
      session: undefined,
      error: new Error('shell unavailable on node'),
    });
    await mountAndOpen();
    await selectHost('node-mac');
    await typeRemoteCwd('/Users/me/src/relay-ide');
    await submit();

    expect(text('.add-workspace-error-msg')).toContain(
      'shell unavailable on node'
    );
    expect(dialogEl().open).toBe(true);
    expect(
      window.localStorage.getItem('relay-ide.remote-node-cwd.node-mac')
    ).toBeNull();
  });

  it('switching back to this host restores the folder browser', async () => {
    await mountAndOpen();
    await selectHost('node-mac');
    await selectHost('local');

    expect(container.querySelector('#aw-remote-cwd')).toBeNull();
    expect(container.querySelectorAll('.tree-row')).toHaveLength(2);
    expect(submitButton().disabled).toBe(true);
  });
});
