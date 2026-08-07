/**
 * File-RPC-gated workspace actions (#654).
 *
 * These actions require the active node's relay helper to support file RPC.
 * When `activeNodeFileRpcAvailable` is explicitly `false` in the ActionContext,
 * the action's `when` predicate returns false and `disabledReason` supplies
 * a tooltip naming the missing capability — the command palette renders these
 * as greyed-out entries so users know why the action is unavailable.
 */

import type { ActionMeta } from '../types.js';

function nodeFileRpcAvailable(
  ctx: Parameters<NonNullable<ActionMeta['when']>>[0]
): boolean {
  // `undefined` means we don't know yet (pre-#651 node or unhydrated context).
  // Treat unknown as available (optimistic) — only explicit `false` gates.
  return ctx.activeNodeFileRpcAvailable !== false;
}

function fileRpcDisabledReason(
  ctx: Parameters<NonNullable<ActionMeta['disabledReason']>>[0]
): string | undefined {
  if (ctx.activeNodeFileRpcAvailable === false) {
    return 'file rpc unavailable on this node — check the node helper status';
  }
  return undefined;
}

/**
 * Open a file browser panel on the active workspace.
 * Requires file RPC to resolve FileRefs to content.
 */
export const workspaceOpenFileBrowser: ActionMeta = {
  id: 'workspace.open-file-browser',
  label: 'open file browser',
  description: 'browse files on the active node',
  aliases: ['files', 'browse files', 'file explorer'],
  category: 'workspace',
  icon: '□',
  when: (ctx) => !!ctx.workspacePath && nodeFileRpcAvailable(ctx),
  disabledReason: (ctx) => {
    if (!ctx.workspacePath) return undefined;
    return fileRpcDisabledReason(ctx);
  },
};

/**
 * Attach a file block to the active workbench.
 * Requires file RPC to load file content into the block.
 */
export const workbenchAddFileBlock: ActionMeta = {
  id: 'workspace.add-file-block',
  label: 'add file block',
  description: 'attach a file viewer to the workbench',
  aliases: ['file block', 'add file', 'open file in workbench'],
  category: 'workspace',
  icon: '□',
  when: (ctx) => !!ctx.workspacePath && nodeFileRpcAvailable(ctx),
  disabledReason: (ctx) => {
    if (!ctx.workspacePath) return undefined;
    return fileRpcDisabledReason(ctx);
  },
};

export const workspaceFileRpcActions: ActionMeta[] = [
  workspaceOpenFileBrowser,
  workbenchAddFileBlock,
];
