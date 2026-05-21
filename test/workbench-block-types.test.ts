/**
 * Type-level and runtime tests for WorkbenchBlock contracts (slice 1, #619).
 *
 * Two categories:
 *   1. Type-level assertions — verify that discriminated-union narrowing and
 *      generic constraints work as expected at compile time.
 *   2. Runtime round-trip — each descriptor kind is constructed and survives
 *      JSON.stringify → JSON.parse without loss (forward-compat sanity).
 */

import { describe, expect, it } from 'vitest';

import type {
  AgentBlockDescriptor,
  ArtifactBlockDescriptor,
  CustomBlockDescriptor,
  FileBlockDescriptor,
  JsonValue,
  MarkdownBlockDescriptor,
  TerminalBlockDescriptor,
  WorkContextBlockDescriptor,
  WorkbenchBlockDescriptor,
  WorkbenchBlockKind,
  WorkbenchBlockRenderer,
  WorkbenchBlockRendererProps,
} from '../shared/workbench-block-types.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';
import type { WorkContextRedactionClass } from '../shared/work-context.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Compile-time exhaustiveness helper — fails if `_x` is not `never`. */
function assertNever(_x: never): never {
  throw new Error('assertNever reached');
}

/**
 * Type-level assertion: asserts that T extends Expected.
 * We call it at runtime as a no-op; the TS compiler enforces correctness.
 */
function assertType<Expected>(_value: Expected): void {
  /* type check only */
}

/** Build a minimal WorkbenchBlockContext stub for type-level tests. */
function makeContext() {
  return {
    capabilityGrants: [],
    requestCapability: async (_name: RelayCapabilityBit) => true,
    close: () => {},
    emitAuditEvent: (_event: {
      type: string;
      payload?: Record<string, JsonValue>;
    }) => {},
  } as const;
}

// ---------------------------------------------------------------------------
// helpers for building descriptors
// ---------------------------------------------------------------------------

function makePrivacy() {
  return {
    classification: 'internal' as const,
    retention: 'session' as const,
    rawPayloadStored: false,
    redaction: {
      redacted: false,
      strategy: 'none' as const,
      classes: [] as WorkContextRedactionClass[],
    },
  };
}

function makeArtifactRef() {
  return {
    id: 'artifact:test-01',
    kind: 'file' as const,
    title: 'output.log',
    privacy: makePrivacy(),
  };
}

function makeCapabilityGrantRef() {
  return {
    id: 'grant-1',
    ref: 'acl:local:1.0',
    policyClass: 'read-only' as const,
    privacy: makePrivacy(),
  };
}

// ---------------------------------------------------------------------------
// 1. Type-level narrowing tests
// ---------------------------------------------------------------------------

describe('WorkbenchBlockDescriptor discriminated union narrowing', () => {
  it('narrows to TerminalBlockDescriptor on kind === terminal', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'terminal',
      id: 'b-1',
      title: 'My Terminal',
      capabilityRequirements: ['session:attach'],
      meta: {
        sessionRef: {
          nodeId: 'local',
          sessionId: 'session-abc',
          tabKind: 'terminal',
          cwd: '/home/user',
        },
      },
    };

    if (desc.kind === 'terminal') {
      // TypeScript must infer sessionRef here without error.
      assertType<string>(desc.meta.sessionRef.nodeId);
      assertType<string>(desc.meta.sessionRef.sessionId);
    } else {
      // If this branch were reachable we have a narrowing bug.
      assertNever(desc as never);
    }
  });

  it('narrows to AgentBlockDescriptor on kind === agent', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'agent',
      id: 'b-2',
      title: 'Claude Code',
      capabilityRequirements: ['session:attach'],
      meta: { actorRef: { kind: 'actor', id: 'actor-123' } },
    };

    if (desc.kind === 'agent') {
      assertType<'actor'>(desc.meta.actorRef.kind);
    }
  });

  it('narrows to WorkContextBlockDescriptor on kind === work-context', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'work-context',
      id: 'b-3',
      title: 'Issue #619',
      capabilityRequirements: [],
      meta: { workContextRef: 'wc:abc-123' },
    };

    if (desc.kind === 'work-context') {
      assertType<string>(desc.meta.workContextRef);
    }
  });

  it('narrows to FileBlockDescriptor on kind === file', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'file',
      id: 'b-4',
      title: 'server/index.ts',
      capabilityRequirements: ['rpc:fs:read'],
      meta: {
        fileRef: { kind: 'file', id: 'rpc:fs:local:%2Fserver%2Findex.ts' },
        mode: 'read',
      },
    };

    if (desc.kind === 'file') {
      // fileRef is FileRef | FileResourceRef; narrow to legacy FileRef to check .kind
      const ref = desc.meta.fileRef;
      if ('id' in ref) {
        assertType<'file'>(ref.kind);
      }
      assertType<'read' | 'edit' | 'diff' | undefined>(desc.meta.mode);
    }
  });

  it('narrows to ArtifactBlockDescriptor on kind === artifact', () => {
    const artifactRef = makeArtifactRef();
    const desc: WorkbenchBlockDescriptor = {
      kind: 'artifact',
      id: 'b-5',
      title: 'output.log',
      capabilityRequirements: [],
      meta: { artifactRef },
    };

    if (desc.kind === 'artifact') {
      assertType<string>(desc.meta.artifactRef.id);
    }
  });

  it('narrows to MarkdownBlockDescriptor on kind === markdown', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'markdown',
      id: 'b-6',
      title: 'README',
      capabilityRequirements: [],
      meta: { content: '# hello' },
    };

    if (desc.kind === 'markdown') {
      assertType<string>(desc.meta.content);
    }
  });

  it('narrows to CustomBlockDescriptor on kind === custom', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'custom',
      id: 'b-7',
      title: 'My Plugin',
      capabilityRequirements: [],
      meta: { rendererId: 'my-plugin:dashboard', props: { foo: 'bar' } },
    };

    if (desc.kind === 'custom') {
      assertType<string>(desc.meta.rendererId);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Renderer generic constraint type tests
// ---------------------------------------------------------------------------

describe('WorkbenchBlockRenderer generic constraint', () => {
  it('accepts a renderer that matches its kind', () => {
    // This must type-check cleanly: the renderer receives TerminalBlockDescriptor.
    const _TerminalRenderer: WorkbenchBlockRenderer<'terminal'> = ({
      descriptor,
      context: _ctx,
    }) => {
      // The discriminated union is already narrowed via the generic.
      assertType<'terminal'>(descriptor.kind);
      assertType<string>(descriptor.meta.sessionRef.nodeId);
      return null;
    };
    // Instantiate so the compiler exercises the type (no unused-var warning).
    expect(typeof _TerminalRenderer).toBe('function');
  });

  it('ensures props for one kind cannot receive descriptors of another kind at type level', () => {
    // Build terminal renderer props and agent renderer props; verify Extract works.
    const terminalDesc: TerminalBlockDescriptor = {
      kind: 'terminal',
      id: 'x',
      title: 'T',
      capabilityRequirements: [],
      meta: {
        sessionRef: {
          nodeId: 'local',
          sessionId: 's',
          tabKind: 'terminal',
          cwd: '/',
        },
      },
    };

    const agentDesc: AgentBlockDescriptor = {
      kind: 'agent',
      id: 'y',
      title: 'A',
      capabilityRequirements: [],
      meta: { actorRef: { kind: 'actor', id: 'a1' } },
    };

    // Correct assignment — should compile.
    const terminalProps: WorkbenchBlockRendererProps<'terminal'> = {
      descriptor: terminalDesc,
      context: makeContext(),
    };

    // agentDesc is NOT assignable to WorkbenchBlockRendererProps<'terminal'>.
    // The @ts-expect-error sits on the line directly above the failing property.
    const _bad: WorkbenchBlockRendererProps<'terminal'> = {
      // @ts-expect-error — Type '"agent"' is not assignable to type '"terminal"'.
      descriptor: agentDesc,
      context: makeContext(),
    };

    expect(terminalProps.descriptor.kind).toBe('terminal');
    // Suppress unused warning — _bad is used by @ts-expect-error above.
    void _bad;
  });
});

// ---------------------------------------------------------------------------
// 3. WorkbenchBlockKind exhaustiveness guard
// ---------------------------------------------------------------------------

describe('WorkbenchBlockKind union', () => {
  it('covers all expected literals', () => {
    const kinds: WorkbenchBlockKind[] = [
      'terminal',
      'agent',
      'work-context',
      'file',
      'artifact',
      'markdown',
      'custom',
    ];
    expect(kinds).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// 4. Runtime JSON round-trip — one descriptor per kind
// ---------------------------------------------------------------------------

describe('WorkbenchBlockDescriptor JSON round-trip', () => {
  const artifactRef = makeArtifactRef();

  const cases: WorkbenchBlockDescriptor[] = [
    {
      kind: 'terminal',
      id: 'rt-terminal',
      title: 'Terminal',
      capabilityRequirements: ['session:attach', 'session:read'],
      meta: {
        sessionRef: {
          nodeId: 'local',
          sessionId: 'sess-001',
          tabKind: 'terminal',
          cwd: '/workspace',
        },
      },
    } satisfies TerminalBlockDescriptor,
    {
      kind: 'agent',
      id: 'rt-agent',
      title: 'Claude Code',
      capabilityRequirements: ['session:attach'],
      meta: {
        actorRef: { kind: 'actor', id: 'actor-001', displayName: 'claude' },
      },
    } satisfies AgentBlockDescriptor,
    {
      kind: 'work-context',
      id: 'rt-work-context',
      title: 'Issue #619',
      capabilityRequirements: [],
      meta: { workContextRef: 'wc:test-context-001' },
    } satisfies WorkContextBlockDescriptor,
    {
      kind: 'file',
      id: 'rt-file',
      title: 'server/index.ts',
      capabilityRequirements: ['rpc:fs:read'],
      meta: {
        fileRef: {
          kind: 'file',
          id: 'rpc:fs:local:%2Fserver%2Findex.ts',
          displayName: 'index.ts',
        },
        mode: 'diff',
      },
    } satisfies FileBlockDescriptor,
    {
      kind: 'artifact',
      id: 'rt-artifact',
      title: 'output.log',
      capabilityRequirements: [],
      meta: { artifactRef },
    } satisfies ArtifactBlockDescriptor,
    {
      kind: 'markdown',
      id: 'rt-markdown',
      title: 'Notes',
      capabilityRequirements: [],
      meta: { content: '# Slice 1\n\nTypes only.' },
    } satisfies MarkdownBlockDescriptor,
    {
      kind: 'custom',
      id: 'rt-custom',
      title: 'Dashboard',
      capabilityRequirements: ['rpc:fs:read'],
      meta: {
        rendererId: 'my-plugin:dashboard',
        dataRefs: ['ref:data-001', 'ref:data-002'],
        props: { theme: 'dark', count: 42, nested: { ok: true } },
      },
    } satisfies CustomBlockDescriptor,
  ];

  it('round-trips each descriptor kind through JSON.stringify / JSON.parse', () => {
    for (const descriptor of cases) {
      const serialised = JSON.stringify(descriptor);
      const parsed = JSON.parse(serialised) as WorkbenchBlockDescriptor;

      expect(parsed.kind).toBe(descriptor.kind);
      expect(parsed.id).toBe(descriptor.id);
      expect(parsed.title).toBe(descriptor.title);
      expect(parsed.capabilityRequirements).toEqual(
        descriptor.capabilityRequirements
      );
      // Deep-equal check on the full object (meta included).
      expect(parsed).toEqual(descriptor);
    }
  });

  it('round-trips produce the correct kind for all 7 variants', () => {
    const roundTripped = cases.map((d) => {
      const parsed = JSON.parse(JSON.stringify(d)) as WorkbenchBlockDescriptor;
      return parsed.kind;
    });

    expect(roundTripped).toEqual([
      'terminal',
      'agent',
      'work-context',
      'file',
      'artifact',
      'markdown',
      'custom',
    ]);
  });

  it('terminal descriptor meta survives round-trip', () => {
    const desc = cases.find(
      (d) => d.kind === 'terminal'
    ) as TerminalBlockDescriptor;
    const parsed = JSON.parse(JSON.stringify(desc)) as TerminalBlockDescriptor;
    expect(parsed.meta.sessionRef.nodeId).toBe('local');
    expect(parsed.meta.sessionRef.sessionId).toBe('sess-001');
    expect(parsed.meta.sessionRef.tabKind).toBe('terminal');
    expect(parsed.meta.sessionRef.cwd).toBe('/workspace');
  });

  it('file descriptor mode is preserved through round-trip', () => {
    const desc = cases.find((d) => d.kind === 'file') as FileBlockDescriptor;
    const parsed = JSON.parse(JSON.stringify(desc)) as FileBlockDescriptor;
    expect(parsed.meta.mode).toBe('diff');
    // The test case uses a legacy FileRef with .kind; narrow before accessing
    const ref = parsed.meta.fileRef;
    if ('id' in ref) {
      expect(ref.kind).toBe('file');
    }
  });

  it('custom descriptor nested props survive round-trip', () => {
    const desc = cases.find(
      (d) => d.kind === 'custom'
    ) as CustomBlockDescriptor;
    const parsed = JSON.parse(JSON.stringify(desc)) as CustomBlockDescriptor;
    expect(parsed.meta.rendererId).toBe('my-plugin:dashboard');
    expect(parsed.meta.dataRefs).toEqual(['ref:data-001', 'ref:data-002']);
    expect(parsed.meta.props?.['theme']).toBe('dark');
    expect(parsed.meta.props?.['count']).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 5. WorkbenchBlockContext shape check
// ---------------------------------------------------------------------------

describe('WorkbenchBlockContext helpers', () => {
  it('requestCapability returns a Promise<boolean>', async () => {
    const ctx = makeContext();
    const result = await ctx.requestCapability('rpc:fs:read');
    expect(typeof result).toBe('boolean');
  });

  it('emitAuditEvent accepts an event without throwing', () => {
    const ctx = makeContext();
    expect(() =>
      ctx.emitAuditEvent({ type: 'block:opened', payload: { blockId: 'b-1' } })
    ).not.toThrow();
  });

  it('capabilityGrants accepts CapabilityGrantRef values', () => {
    const grant = makeCapabilityGrantRef();
    const ctx = { ...makeContext(), capabilityGrants: [grant] };
    expect(ctx.capabilityGrants[0]?.id).toBe('grant-1');
  });
});
