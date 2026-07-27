/**
 * Block-create helpers (#631) — translate a `WorkbenchBlockCreateRequest`
 * (from the picker dialog) into a typed `WorkbenchBlockDescriptor` that the
 * canvas can persist.
 *
 * Lives outside the dialog so the canvas (or any future block-spawn surface:
 * command palette, agent-authored creates via #629's launch hook) can reuse
 * the exact same translation. The function is pure and synchronous.
 */

import type {
  ArtifactBlockDescriptor,
  CustomBlockDescriptor,
  FileBlockDescriptor,
  MarkdownBlockDescriptor,
  TerminalBlockDescriptor,
  WorkbenchBlockDescriptor,
  WorkContextBlockDescriptor,
} from '../../../shared/workbench-block-types.js';
import type { WorkbenchBlockEnvironmentRef } from '../../../shared/workbench-block-environment.js';
import type { WorkbenchBlockCreateRequest } from './WorkbenchBlockCreateDialog.js';

export interface BuildBlockDescriptorInput {
  request: WorkbenchBlockCreateRequest;
  /** Stable id factory — usually `crypto.randomUUID`, but injected for tests. */
  idFactory: () => string;
}

/**
 * Translate a create-dialog request into a typed descriptor.
 *
 * Every variant carries the same `environment` envelope so resume/attach can
 * reconstruct the launch context via `resolveBlockEnvironment`. Per-kind
 * `meta` shapes get safe defaults that the renderer host can refine:
 *
 *  - terminal: sessionRef with `nodeId`/`cwd` from the env; sessionId is
 *    deliberately left as `pending:<blockId>` so #629's launch hook can swap
 *    it for the real id once the session is created.
 *  - markdown: empty content; the user can fill it in inline.
 *  - file/artifact/work-context/custom: minimal stubs — full wiring lives in
 *    the respective slices.
 */
export function buildBlockDescriptor(
  input: BuildBlockDescriptorInput
): WorkbenchBlockDescriptor {
  const { request, idFactory } = input;
  const id = idFactory();
  const base = {
    id,
    title: request.title,
    capabilityRequirements: [] as never[],
    environment: request.environment,
  };

  switch (request.kind) {
    case 'terminal': {
      const desc: TerminalBlockDescriptor = {
        ...base,
        kind: 'terminal',
        capabilityRequirements: ['session:create:terminal'],
        meta: {
          sessionRef: {
            nodeId: request.environment.nodeId,
            sessionId: `pending:${id}`,
            tabKind: 'terminal',
            cwd: request.environment.cwd,
          },
        },
      };
      return desc;
    }
    case 'file': {
      const desc: FileBlockDescriptor = {
        ...base,
        kind: 'file',
        capabilityRequirements: ['rpc:fs:read'],
        meta: {
          fileRef: {
            kind: 'file',
            id: `rpc:fs:${request.environment.nodeId}:${encodeURIComponent(request.environment.cwd)}`,
            displayName: request.title,
          },
          mode: 'read',
        },
      };
      return desc;
    }
    case 'markdown': {
      const desc: MarkdownBlockDescriptor = {
        ...base,
        kind: 'markdown',
        meta: { content: '' },
      };
      return desc;
    }
    case 'work-context': {
      const desc: WorkContextBlockDescriptor = {
        ...base,
        kind: 'work-context',
        meta: { workContextRef: `pending:${id}` },
      };
      return desc;
    }
    case 'artifact': {
      const desc: ArtifactBlockDescriptor = {
        ...base,
        kind: 'artifact',
        meta: {
          artifactRef: {
            id: `pending:${id}`,
            kind: 'file',
            title: request.title,
            privacy: {
              classification: 'internal',
              retention: 'session',
              rawPayloadStored: false,
              redaction: { redacted: false, strategy: 'none', classes: [] },
            },
          },
        },
      };
      return desc;
    }
    case 'custom': {
      const desc: CustomBlockDescriptor = {
        ...base,
        kind: 'custom',
        meta: { rendererId: 'pending', props: {} },
      };
      return desc;
    }
    default: {
      const _exhaustive: never = request.kind;
      throw new Error(`unhandled block kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Read the typed env metadata off a descriptor, returning `undefined` for
 * legacy blocks. Convenience wrapper so call sites don't reach into private
 * shape directly.
 */
export function readBlockEnvironment(descriptor: {
  environment?: WorkbenchBlockEnvironmentRef;
}): WorkbenchBlockEnvironmentRef | undefined {
  return descriptor.environment;
}
