// #1287 slice 2 — which lanes the add-project dialog may actually reveal.
//
// Pins the defect this closes: `ensureProjectWorkspace` uses a status-agnostic
// lookup, so an ARCHIVED project lane came back as `{created: false}` and was
// reported in the `workspaces` array. The dialog treated it as lane-ready and
// fired `onWorkspacesAdded`, but `GET /hub/ia/workspaces` -> `listWorkspaces()`
// hides archived rows — the user was told the lane resolved and saw nothing.

import { describe, expect, it } from 'vitest';

import { resolveBulkAddLanes } from '../../frontend/src/lib/bulk-add-lanes.js';

const REPO = '/home/me/code/relay-ide';
const OTHER = '/home/me/code/notes';

describe('resolveBulkAddLanes', () => {
  it('reveals a freshly created lane with nothing to report', () => {
    expect(
      resolveBulkAddLanes({
        added: [
          {
            path: REPO,
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
          },
        ],
        errors: [],
        workspaces: [
          {
            path: REPO,
            workspaceId: 'ws:project%3Adeadbeefdeadbeef',
            name: 'relay-ide',
            created: true,
            archived: false,
          },
        ],
      })
    ).toEqual({
      laneReadyPaths: [REPO],
      registeredPaths: [REPO],
      blockers: [],
    });
  });

  it('reveals a duplicate re-add lane while still reporting "Already exists"', () => {
    const outcome = resolveBulkAddLanes({
      added: [],
      errors: [{ path: REPO, error: 'Already exists' }],
      workspaces: [
        {
          path: REPO,
          workspaceId: 'ws:project%3Adeadbeefdeadbeef',
          name: 'relay-ide',
          created: false,
          archived: false,
        },
      ],
    });
    expect(outcome.laneReadyPaths).toEqual([REPO]);
    // Nothing was appended to `config.repos` — the hub rejected the duplicate.
    expect(outcome.registeredPaths).toEqual([]);
    expect(outcome.blockers).toEqual([{ path: REPO, error: 'Already exists' }]);
  });

  it('never reveals an archived lane and says why (#1287)', () => {
    const outcome = resolveBulkAddLanes({
      added: [
        {
          path: REPO,
          name: 'relay-ide',
          isGitRepo: true,
          defaultBranch: 'nightly',
        },
      ],
      errors: [],
      workspaces: [
        {
          path: REPO,
          workspaceId: 'ws:project%3Adeadbeefdeadbeef',
          name: 'Retired lane',
          created: false,
          archived: true,
        },
      ],
    });
    // Not reported as ready — `listWorkspaces()` will not return it…
    expect(outcome.laneReadyPaths).toEqual([]);
    // …and it is NOT a silent no-op: the archive is named explicitly.
    expect(outcome.blockers).toHaveLength(1);
    expect(outcome.blockers[0]!.path).toBe(REPO);
    expect(outcome.blockers[0]!.error).toContain('archived');
    expect(outcome.blockers[0]!.error).toContain('Retired lane');
    // …and the hub DID append the path to `config.repos`, so the caller still
    // owes a refresh. Reporting `[]` here would trade the silent success for a
    // stale client: registered on the hub, absent from the UI until reload.
    expect(outcome.registeredPaths).toEqual([REPO]);
  });

  it('reports every added path as needing a refresh when ALL lanes are archived (#1287)', () => {
    // The regression this pins: `laneReadyPaths` is empty and `blockers` is
    // non-empty, so the dialog takes its error early-return. It must still hand
    // the caller a reason to refresh, or a repo the hub just registered stays
    // invisible until a full page reload.
    const outcome = resolveBulkAddLanes({
      added: [
        { path: REPO, name: 'relay-ide', isGitRepo: true, defaultBranch: null },
        { path: OTHER, name: 'notes', isGitRepo: false, defaultBranch: null },
      ],
      errors: [],
      workspaces: [
        {
          path: REPO,
          workspaceId: 'ws:project%3Aaaaaaaaaaaaaaaaa',
          name: 'relay-ide',
          created: false,
          archived: true,
        },
        {
          path: OTHER,
          workspaceId: 'ws:project%3Abbbbbbbbbbbbbbbb',
          name: 'notes',
          created: false,
          archived: true,
        },
      ],
    });
    expect(outcome.laneReadyPaths).toEqual([]);
    expect(outcome.registeredPaths).toEqual([REPO, OTHER]);
    expect(outcome.blockers).toHaveLength(2);
  });

  it('still reveals the live lanes when a sibling path is archived', () => {
    const outcome = resolveBulkAddLanes({
      added: [],
      errors: [],
      workspaces: [
        {
          path: REPO,
          workspaceId: 'ws:project%3Aaaaaaaaaaaaaaaaa',
          name: 'relay-ide',
          created: true,
          archived: false,
        },
        {
          path: OTHER,
          workspaceId: 'ws:project%3Abbbbbbbbbbbbbbbb',
          name: 'notes',
          created: false,
          archived: true,
        },
      ],
    });
    expect(outcome.laneReadyPaths).toEqual([REPO]);
    expect(outcome.blockers.map((b) => b.path)).toEqual([OTHER]);
    expect(outcome.registeredPaths).toEqual([]);
  });

  it('falls back to the added paths on a hub that reports no lanes', () => {
    // Older hub, or a degraded IA store: `workspaces` is absent/empty. Behaves
    // exactly as it did before the field existed.
    for (const workspaces of [undefined, []]) {
      expect(
        resolveBulkAddLanes({
          added: [
            {
              path: REPO,
              name: 'relay-ide',
              isGitRepo: true,
              defaultBranch: null,
            },
          ],
          errors: [],
          ...(workspaces ? { workspaces } : {}),
        })
      ).toEqual({
        laneReadyPaths: [REPO],
        registeredPaths: [REPO],
        blockers: [],
      });
    }
  });

  it('treats a hub that omits `archived` as not archived', () => {
    const outcome = resolveBulkAddLanes({
      added: [],
      errors: [{ path: REPO, error: 'Already exists' }],
      workspaces: [
        {
          path: REPO,
          workspaceId: 'ws:project%3Adeadbeefdeadbeef',
          name: 'relay-ide',
          created: false,
        },
      ],
    });
    expect(outcome.laneReadyPaths).toEqual([REPO]);
  });
});
