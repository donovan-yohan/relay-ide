// #759: integration tests for the production AnchorFileFetcher.
// Verifies the fetcher resolves a live in-scope scoped session, runs the
// session-scoped File RPC under the `rpc:fs:read` policy gate, maps the node
// response onto an AnchorFileFetchResult, and falls back to "unresolvable"
// (null) when no session scope or authorization is available — NEVER local-stat.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAnchorFileFetcher,
  type AnchorFetcherNodeLinks,
  type AnchorFetcherNodeRegistry,
  type AnchorFetcherSessionEnvelopes,
} from '../server/anchor-file-fetcher.js';
import {
  ANCHOR_RESOLUTION_CAPABILITY,
  type AnchorFileFetchTarget,
} from '../server/anchor-resolution.js';
import type { ScopedSessionSummary } from '../server/session-envelope-registry.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../shared/relay-node-protocol.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { RELAY_SECURITY_POLICY_VERSION } from '../shared/security-policy.js';

const NODE_ID = 'node-alpha';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-anchor-fetch-'));
  tmpDirs.push(dir);
  return dir;
}

/** A node whose ACL grants `rpc:fs:read` over a `node`-kind scope (matches any). */
function onlineNode(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: NODE_ID,
    status: 'online',
    protocolVersion: RELAY_NODE_LINK_PROTOCOL_VERSION,
    credentialState: 'active',
    platform: process.platform,
    trust: {
      state: 'trusted',
      level: 'full',
      policy: {
        policyVersion: RELAY_SECURITY_POLICY_VERSION,
        ref: 'acl:test',
        trustTier: 'dev',
        allowed: ['rpc:fs:read'],
        requiresConfirmation: [],
        scope: { kind: 'node' },
      },
    },
    // The remaining HubNodeSummary fields are not read by the fetcher / policy
    // evaluator for an `rpc.fs.read` allow; cast keeps the fixture small.
    ...overrides,
  } as unknown as HubNodeSummary;
}

function scopedSession(root: string, nodeId = NODE_ID): ScopedSessionSummary {
  return {
    sessionId: 'sess-1',
    globalSessionId: `${nodeId}:sess-1`,
    nodeId,
    intent: {
      kind:
        nodeId === DEFAULT_LOCAL_NODE_ID
          ? 'local-dev-compatibility'
          : 'routed-node-session',
      description: 'test',
    },
    scope: {
      kind:
        nodeId === DEFAULT_LOCAL_NODE_ID ? 'local-compatibility' : 'node-cwd',
      nodeId,
      cwd: root,
    },
    peerIdentity: { kind: 'local-user', id: 'local-dev' },
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    revocable: true,
    status: 'active',
    revokedAt: null,
    revokeReason: null,
    expired: false,
    expiresInMs: null,
  } as ScopedSessionSummary;
}

function deps(input: {
  nodes: HubNodeSummary[];
  sessions: ScopedSessionSummary[];
  request: AnchorFetcherNodeLinks['request'];
  hasActiveNode?: boolean;
}): {
  registry: AnchorFetcherNodeRegistry;
  nodeLinks: AnchorFetcherNodeLinks;
  sessionEnvelopes: AnchorFetcherSessionEnvelopes;
} {
  return {
    registry: { listNodes: () => input.nodes },
    nodeLinks: {
      hasActiveNode: () => input.hasActiveNode ?? true,
      request: input.request,
    },
    sessionEnvelopes: { listSummaries: () => input.sessions },
  };
}

function target(
  root: string,
  file: string,
  preferRead = false,
  nodeId = NODE_ID
): AnchorFileFetchTarget {
  return { nodeId, path: path.join(root, file), preferRead };
}

describe('createAnchorFileFetcher — happy path (stat)', () => {
  it('resolves found:true with size+mtime from a stat response', async () => {
    const root = makeRoot();
    const request = vi.fn(async (_nodeId, type) => {
      expect(type).toBe('fs.stat');
      return {
        operation: 'stat',
        stat: {
          type: 'file',
          size: 123,
          mtimeMs: 4567,
          path: 'x',
          name: 'x',
          mode: 0,
        },
      };
    });
    const fetcher = createAnchorFileFetcher(
      deps({ nodes: [onlineNode()], sessions: [scopedSession(root)], request })
    );
    const result = await fetcher(target(root, 'a.ts', false));
    expect(result).toEqual({
      found: true,
      grantedCapability: ANCHOR_RESOLUTION_CAPABILITY,
      size: 123,
      mtimeMs: 4567,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('createAnchorFileFetcher — happy path (read, preferRead)', () => {
  it('resolves found:true and hashes content for an authoritative sha', async () => {
    const root = makeRoot();
    const content = 'export const answer = 42;\n';
    const expectedSha = crypto
      .createHash('sha256')
      .update(Buffer.from(content, 'utf8'))
      .digest('hex');
    const request = vi.fn(async (_nodeId, type) => {
      expect(type).toBe('fs.read');
      return {
        operation: 'read',
        encoding: 'utf8',
        content,
        bytesRead: Buffer.byteLength(content),
        truncatedBytes: false,
        truncatedLines: false,
        maxBytes: 65536,
      };
    });
    const fetcher = createAnchorFileFetcher(
      deps({ nodes: [onlineNode()], sessions: [scopedSession(root)], request })
    );
    const result = await fetcher(target(root, 'a.ts', true));
    expect(result).toMatchObject({
      found: true,
      grantedCapability: ANCHOR_RESOLUTION_CAPABILITY,
      contentSha256: expectedSha,
    });
  });

  it('omits sha when the read was truncated (cannot trust a partial hash)', async () => {
    const root = makeRoot();
    const request = vi.fn(async () => ({
      operation: 'read',
      encoding: 'utf8',
      content: 'partial',
      bytesRead: 7,
      truncatedBytes: true,
      truncatedLines: false,
      maxBytes: 7,
    }));
    const fetcher = createAnchorFileFetcher(
      deps({ nodes: [onlineNode()], sessions: [scopedSession(root)], request })
    );
    const result = await fetcher(target(root, 'a.ts', true));
    expect(result?.found).toBe(true);
    if (result?.found) expect(result.contentSha256).toBeUndefined();
  });
});

describe('createAnchorFileFetcher — local compatibility node', () => {
  it('resolves an existing DEFAULT_LOCAL_NODE_ID file through local File RPC without a paired node link', async () => {
    const root = makeRoot();
    const filePath = path.join(root, 'local.ts');
    fs.writeFileSync(filePath, 'export const local = true;\n');
    const request = vi.fn();
    const fetcher = createAnchorFileFetcher(
      deps({
        nodes: [],
        sessions: [scopedSession(root, DEFAULT_LOCAL_NODE_ID)],
        request,
        hasActiveNode: false,
      })
    );

    const result = await fetcher(
      target(root, 'local.ts', false, DEFAULT_LOCAL_NODE_ID)
    );

    expect(result).toMatchObject({
      found: true,
      grantedCapability: ANCHOR_RESOLUTION_CAPABILITY,
      size: fs.statSync(filePath).size,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not use the local fallback for non-local nodes without a paired link', async () => {
    const root = makeRoot();
    fs.writeFileSync(
      path.join(root, 'remote-looking.ts'),
      'exists on the hub only\n'
    );
    const request = vi.fn();
    const fetcher = createAnchorFileFetcher(
      deps({
        nodes: [onlineNode()],
        sessions: [scopedSession(root)],
        request,
        hasActiveNode: false,
      })
    );

    const result = await fetcher(target(root, 'remote-looking.ts', false));

    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('createAnchorFileFetcher — missing / not-a-file', () => {
  it('maps a non-file stat (directory) to found:false', async () => {
    const root = makeRoot();
    const request = vi.fn(async () => ({
      operation: 'stat',
      stat: {
        type: 'directory',
        size: 0,
        mtimeMs: 1,
        path: 'd',
        name: 'd',
        mode: 0,
      },
    }));
    const fetcher = createAnchorFileFetcher(
      deps({ nodes: [onlineNode()], sessions: [scopedSession(root)], request })
    );
    const result = await fetcher(target(root, 'sub', false));
    expect(result).toEqual({
      found: false,
      grantedCapability: ANCHOR_RESOLUTION_CAPABILITY,
    });
  });

  it('maps a NOT_FOUND link error to found:false (authorized fetch, gone file)', async () => {
    const root = makeRoot();
    const request = vi.fn(async () => {
      throw new Error('FILE_RPC_NOT_FOUND');
    });
    const fetcher = createAnchorFileFetcher(
      deps({ nodes: [onlineNode()], sessions: [scopedSession(root)], request })
    );
    const result = await fetcher(target(root, 'gone.ts', false));
    expect(result).toEqual({
      found: false,
      grantedCapability: ANCHOR_RESOLUTION_CAPABILITY,
    });
  });
});

describe('createAnchorFileFetcher — unresolvable (null, never local-stat)', () => {
  it('returns null when no live session scope contains the path', async () => {
    const root = makeRoot();
    const request = vi.fn(async () => ({
      operation: 'stat',
      stat: { type: 'file' },
    }));
    // Session scoped to a DIFFERENT root → path is outside; no in-scope session.
    const otherRoot = makeRoot();
    const fetcher = createAnchorFileFetcher(
      deps({
        nodes: [onlineNode()],
        sessions: [scopedSession(otherRoot)],
        request,
      })
    );
    const result = await fetcher(target(root, 'a.ts', false));
    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('returns null when there are no live sessions at all', async () => {
    const root = makeRoot();
    const request = vi.fn();
    const fetcher = createAnchorFileFetcher(
      deps({ nodes: [onlineNode()], sessions: [], request })
    );
    expect(await fetcher(target(root, 'a.ts', false))).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('returns null when the node is offline (no File RPC path)', async () => {
    const root = makeRoot();
    const request = vi.fn();
    const offline = onlineNode({
      status: 'offline' as HubNodeSummary['status'],
    });
    const fetcher = createAnchorFileFetcher(
      deps({ nodes: [offline], sessions: [scopedSession(root)], request })
    );
    expect(await fetcher(target(root, 'a.ts', false))).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('returns null when the node ACL does NOT grant rpc:fs:read (capability gate)', async () => {
    const root = makeRoot();
    const request = vi.fn();
    const ungranted = onlineNode({
      trust: {
        state: 'trusted',
        level: 'full',
        policy: {
          policyVersion: RELAY_SECURITY_POLICY_VERSION,
          ref: 'acl:test',
          trustTier: 'dev',
          allowed: [], // no rpc:fs:read → policy denies
          requiresConfirmation: [],
          scope: { kind: 'node' },
        },
      } as unknown as HubNodeSummary['trust'],
    });
    const fetcher = createAnchorFileFetcher(
      deps({ nodes: [ungranted], sessions: [scopedSession(root)], request })
    );
    expect(await fetcher(target(root, 'a.ts', false))).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
