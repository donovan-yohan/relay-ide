/**
 * Tests for slice 4 (#654) — command palette gating.
 *
 * Verifies that:
 *   - The Action type now supports `disabledReason` returning a string.
 *   - Actions with `disabledReason` are built with correct metadata.
 *   - The file-rpc-gated workspace actions behave correctly under different
 *     `activeNodeFileRpcAvailable` context values.
 */

import { describe, expect, it } from 'vitest';
import type { ActionContext } from '../../frontend/src/lib/actions/types.js';
import {
  workspaceOpenFileBrowser,
  workbenchAddFileBlock,
} from '../../frontend/src/lib/actions/definitions/workspace-file-rpc.js';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    view: 'workspace',
    workspacePath: '/home/user/project',
    ...overrides,
  };
}

describe('workspace-file-rpc actions — command palette gating (#654)', () => {
  describe('workspaceOpenFileBrowser', () => {
    it('is available when nodeFileRpcAvailable is true', () => {
      expect(
        workspaceOpenFileBrowser.when?.(
          ctx({ activeNodeFileRpcAvailable: true })
        )
      ).toBe(true);
    });

    it('is available when nodeFileRpcAvailable is undefined (optimistic)', () => {
      expect(
        workspaceOpenFileBrowser.when?.(
          ctx({ activeNodeFileRpcAvailable: undefined })
        )
      ).toBe(true);
    });

    it('is NOT available when nodeFileRpcAvailable is false', () => {
      expect(
        workspaceOpenFileBrowser.when?.(
          ctx({ activeNodeFileRpcAvailable: false })
        )
      ).toBe(false);
    });

    it('returns a disabledReason string when nodeFileRpcAvailable is false', () => {
      const reason = workspaceOpenFileBrowser.disabledReason?.(
        ctx({ activeNodeFileRpcAvailable: false })
      );
      expect(reason).toBeTruthy();
      expect(reason).toContain('file rpc unavailable');
    });

    it('returns undefined disabledReason when nodeFileRpcAvailable is true (not disabled)', () => {
      const reason = workspaceOpenFileBrowser.disabledReason?.(
        ctx({ activeNodeFileRpcAvailable: true })
      );
      expect(reason).toBeUndefined();
    });

    it('is NOT available when workspacePath is absent regardless of fileRpc state', () => {
      expect(
        workspaceOpenFileBrowser.when?.(
          ctx({ workspacePath: undefined, activeNodeFileRpcAvailable: true })
        )
      ).toBe(false);
    });

    it('returns no disabledReason when workspacePath is absent (action simply hidden, not degraded)', () => {
      const reason = workspaceOpenFileBrowser.disabledReason?.(
        ctx({ workspacePath: undefined, activeNodeFileRpcAvailable: false })
      );
      // disabledReason only fires for the file-rpc degraded case, not for absent workspace
      expect(reason).toBeUndefined();
    });
  });

  describe('workbenchAddFileBlock', () => {
    it('is available when nodeFileRpcAvailable is true', () => {
      expect(
        workbenchAddFileBlock.when?.(ctx({ activeNodeFileRpcAvailable: true }))
      ).toBe(true);
    });

    it('is NOT available when nodeFileRpcAvailable is false', () => {
      expect(
        workbenchAddFileBlock.when?.(ctx({ activeNodeFileRpcAvailable: false }))
      ).toBe(false);
    });

    it('returns a disabledReason string naming the missing feature', () => {
      const reason = workbenchAddFileBlock.disabledReason?.(
        ctx({ activeNodeFileRpcAvailable: false })
      );
      expect(typeof reason).toBe('string');
      expect(reason).toContain('file rpc unavailable');
      expect(reason).toContain('node helper');
    });
  });

  describe('Action type contract — disabledReason field', () => {
    it('disabledReason is typed as optional on the Action shape', () => {
      // TypeScript-level assertion: the field must exist (or be absent) without
      // compile errors. The test below validates the runtime shape of our action.
      const action = workspaceOpenFileBrowser;
      expect('disabledReason' in action).toBe(true);
      expect(typeof action.disabledReason).toBe('function');
    });
  });
});
