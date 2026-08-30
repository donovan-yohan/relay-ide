/**
 * #1449: read-path performance work on `GET /sessions/native`. These tests pin
 * the behaviour the optimisation must not break — cache invalidation on
 * mutation, direct nativeId resolution, and the ordering/containment
 * guarantees the response contract depends on.
 */
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeJsonlStateAdapter } from '../../../server/provider-state/claude-jsonl-state-adapter.js';
import { CodexJsonlStateAdapter } from '../../../server/provider-state/codex-jsonl-state-adapter.js';
import { NativeSessionAdapterRegistry } from '../../../server/provider-state/registry.js';

function claudeLine(
  sessionId: string,
  timestamp: string,
  text: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    uuid: `${sessionId}-${timestamp}`,
    cwd: '/tmp/repo',
    timestamp,
    message: { role: 'user', content: text },
    ...extra,
  });
}

function codexLine(sessionId: string, timestamp: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: sessionId,
    id: `${sessionId}-${timestamp}`,
    cwd: '/tmp/repo',
    timestamp,
    message: { role: 'user', content: text },
  });
}

async function claudeRoot(): Promise<{ root: string; projectDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-1449-claude-'));
  const projectDir = path.join(root, 'projects', '-tmp-repo');
  await mkdir(projectDir, { recursive: true });
  return { root, projectDir };
}

async function codexRoot(): Promise<{ root: string; dayDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-1449-codex-'));
  const dayDir = path.join(root, '2026', '01', '01');
  await mkdir(dayDir, { recursive: true });
  return { root, dayDir };
}

describe('#1449 native session summary cache', () => {
  it('re-parses a Claude transcript after it is appended to', async () => {
    const { root, projectDir } = await claudeRoot();
    const sessionPath = path.join(projectDir, 'session-cache.jsonl');
    await writeFile(
      sessionPath,
      `${claudeLine('session-cache', '2026-01-01T00:00:00.000Z', 'first turn')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });

    const before = await adapter.listNativeSessions();
    expect(before).toHaveLength(1);
    expect(before[0]?.metadata?.['lineCount']).toBe(1);
    expect(before[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    const beforeHash = before[0]?.metadata?.['hashSha256'];

    // Second call with no mutation: identical summary (cache hit).
    const cached = await adapter.listNativeSessions();
    expect(cached[0]).toEqual(before[0]);

    await writeFile(
      sessionPath,
      `${claudeLine('session-cache', '2026-01-01T00:00:00.000Z', 'first turn')}\n` +
        `${claudeLine('session-cache', '2026-02-02T00:00:00.000Z', 'second turn')}\n`
    );

    const after = await adapter.listNativeSessions();
    expect(after).toHaveLength(1);
    expect(after[0]?.metadata?.['lineCount']).toBe(2);
    expect(after[0]?.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(after[0]?.metadata?.['hashSha256']).not.toBe(beforeHash);
  });

  it('re-parses a Claude transcript rewritten to the same length', async () => {
    const { root, projectDir } = await claudeRoot();
    const sessionPath = path.join(projectDir, 'session-rewrite.jsonl');
    await writeFile(
      sessionPath,
      `${claudeLine('session-rewrite', '2026-01-01T00:00:00.000Z', 'aaaa')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const before = await adapter.listNativeSessions();
    expect(before[0]?.preview?.text).toContain('aaaa');

    // Same byte length, different content: only mtime distinguishes them.
    await writeFile(
      sessionPath,
      `${claudeLine('session-rewrite', '2026-01-01T00:00:00.000Z', 'bbbb')}\n`
    );

    const after = await adapter.listNativeSessions();
    expect(after[0]?.preview?.text).toContain('bbbb');
    expect(after[0]?.metadata?.['hashSha256']).not.toBe(
      before[0]?.metadata?.['hashSha256']
    );
  });

  it('serves unchanged files from the cache and re-reads changed ones', async () => {
    const { root, projectDir } = await claudeRoot();
    for (let i = 0; i < 3; i += 1) {
      await writeFile(
        path.join(projectDir, `session-hit-${i}.jsonl`),
        `${claudeLine(`session-hit-${i}`, '2026-01-01T00:00:00.000Z', `turn ${i}`)}\n`
      );
    }

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    await adapter.listNativeSessions();
    const afterFirst = adapter.nativeSessionReadStats().summaryCache;
    expect(afterFirst.misses).toBe(3);
    expect(afterFirst.hits).toBe(0);
    expect(afterFirst.size).toBe(3);

    // Nothing changed: the second list must not re-read a single transcript.
    await adapter.listNativeSessions();
    const afterSecond = adapter.nativeSessionReadStats().summaryCache;
    expect(afterSecond.hits).toBe(3);
    expect(afterSecond.misses).toBe(3);

    // One transcript changes: exactly one miss, the other two still hit.
    await writeFile(
      path.join(projectDir, 'session-hit-1.jsonl'),
      `${claudeLine('session-hit-1', '2026-01-01T00:00:00.000Z', 'turn 1')}\n` +
        `${claudeLine('session-hit-1', '2026-05-05T00:00:00.000Z', 'appended')}\n`
    );
    const third = await adapter.listNativeSessions();
    const afterThird = adapter.nativeSessionReadStats().summaryCache;
    expect(afterThird.hits).toBe(5);
    expect(afterThird.misses).toBe(4);
    expect(
      third.find((sn) => sn.nativeId === 'session-hit-1')?.metadata?.[
        'lineCount'
      ]
    ).toBe(2);
  });

  it('re-reads a transcript whose mtime was forged back to its old value', async () => {
    const { root, projectDir } = await claudeRoot();
    const sessionPath = path.join(projectDir, 'session-stamped.jsonl');
    const original = `${claudeLine('session-stamped', '2026-01-01T00:00:00.000Z', 'aaaa')}\n`;
    await writeFile(sessionPath, original);
    const stampTime = new Date(1_700_000_000_000);
    await utimes(sessionPath, stampTime, stampTime);

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const before = await adapter.listNativeSessions();
    expect(before[0]?.preview?.text).toContain('aaaa');

    // Same byte length, mtime restored to the cached value: only ctime moved.
    // Backup and sync tooling produces exactly this shape, so the cache must
    // still notice.
    const replacement = `${claudeLine('session-stamped', '2026-01-01T00:00:00.000Z', 'zzzz')}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await writeFile(sessionPath, replacement);
    await utimes(sessionPath, stampTime, stampTime);

    const after = await adapter.listNativeSessions();
    expect(after[0]?.preview?.text).toContain('zzzz');
    expect(after[0]?.metadata?.['hashSha256']).not.toBe(
      before[0]?.metadata?.['hashSha256']
    );
  });

  it('re-reads after a same-size same-mtime replacement by rename', async () => {
    const { root, projectDir } = await claudeRoot();
    const sessionPath = path.join(projectDir, 'session-renamed.jsonl');
    const sidecarPath = path.join(projectDir, 'sidecar.txt');
    const original = `${claudeLine('session-renamed', '2026-01-01T00:00:00.000Z', 'aaaa')}\n`;
    const replacement = `${claudeLine('session-renamed', '2026-01-01T00:00:00.000Z', 'zzzz')}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));

    await writeFile(sessionPath, original);
    await writeFile(sidecarPath, replacement);
    const stampTime = new Date(1_700_000_000_000);
    await utimes(sessionPath, stampTime, stampTime);
    await utimes(sidecarPath, stampTime, stampTime);

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const before = await adapter.listNativeSessions();
    expect(before[0]?.preview?.text).toContain('aaaa');

    // A different inode with an identical size and mtime now occupies the path.
    await rename(sidecarPath, sessionPath);

    const after = await adapter.listNativeSessions();
    expect(after[0]?.preview?.text).toContain('zzzz');
  });

  it('re-parses a Codex transcript after it is appended to', async () => {
    const { root, dayDir } = await codexRoot();
    const sessionPath = path.join(dayDir, 'rollout-codex-cache.jsonl');
    await writeFile(
      sessionPath,
      `${codexLine('rollout-codex-cache', '2026-01-01T00:00:00.000Z', 'first turn')}\n`
    );

    const adapter = new CodexJsonlStateAdapter({ stateRoot: root });
    const before = await adapter.listNativeSessions();
    expect(before[0]?.metadata?.['lineCount']).toBe(1);

    await writeFile(
      sessionPath,
      `${codexLine('rollout-codex-cache', '2026-01-01T00:00:00.000Z', 'first turn')}\n` +
        `${codexLine('rollout-codex-cache', '2026-03-03T00:00:00.000Z', 'second turn')}\n`
    );

    const after = await adapter.listNativeSessions();
    expect(after[0]?.metadata?.['lineCount']).toBe(2);
    expect(after[0]?.updatedAt).toBe('2026-03-03T00:00:00.000Z');
  });

  it('bounds the summary cache and still returns every session', async () => {
    const { root, projectDir } = await claudeRoot();
    for (let i = 0; i < 6; i += 1) {
      await writeFile(
        path.join(projectDir, `session-${i}.jsonl`),
        `${claudeLine(
          `session-${i}`,
          `2026-01-0${i + 1}T00:00:00.000Z`,
          `turn ${i}`
        )}\n`
      );
    }

    // Capacity smaller than the file count: every list still returns all six.
    const adapter = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheEntries: 2,
    });
    const first = await adapter.listNativeSessions();
    const second = await adapter.listNativeSessions();
    expect(first).toHaveLength(6);
    expect(second).toEqual(first);
  });
});

describe('#1449 native session id resolution', () => {
  it('reads Claude provider state by nativeId without a sourcePath', async () => {
    const { root, projectDir } = await claudeRoot();
    await writeFile(
      path.join(projectDir, 'session-direct.jsonl'),
      `${claudeLine('session-direct', '2026-01-01T00:00:00.000Z', 'direct hit')}\n`
    );
    // Decoys the fast path must not return.
    await writeFile(
      path.join(projectDir, 'session-other.jsonl'),
      `${claudeLine('session-other', '2026-01-02T00:00:00.000Z', 'other')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const snapshot = await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-direct',
    });
    expect(snapshot.ref.nativeId).toBe('session-direct');
    expect(snapshot.sourcePath).toBe(
      path.join(projectDir, 'session-direct.jsonl')
    );
  });

  it('reads Codex provider state by nativeId without a sourcePath', async () => {
    const { root, dayDir } = await codexRoot();
    await writeFile(
      path.join(dayDir, 'rollout-direct.jsonl'),
      `${codexLine('rollout-direct', '2026-01-01T00:00:00.000Z', 'direct hit')}\n`
    );

    const adapter = new CodexJsonlStateAdapter({ stateRoot: root });
    const snapshot = await adapter.readProviderState({
      provider: 'codex',
      nativeId: 'rollout-direct',
    });
    expect(snapshot.ref.nativeId).toBe('rollout-direct');
    expect(snapshot.sourcePath).toBe(path.join(dayDir, 'rollout-direct.jsonl'));
  });

  it('resolves by name without reading every transcript', async () => {
    const { root, projectDir } = await claudeRoot();
    for (let i = 0; i < 5; i += 1) {
      await writeFile(
        path.join(projectDir, `session-fast-${i}.jsonl`),
        `${claudeLine(`session-fast-${i}`, '2026-01-01T00:00:00.000Z', `turn ${i}`)}\n`
      );
    }

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-fast-3',
    });

    const stats = adapter.nativeSessionReadStats();
    // The direct resolver hit, the list walk never ran, and exactly one
    // transcript was opened. Without the fast path this is 5 reads.
    expect(stats.directIdHits).toBe(1);
    expect(stats.directIdFallbacks).toBe(0);
    expect(stats.summaryCache.size).toBe(0);
  });

  it('counts a fallback when the id does not name a transcript', async () => {
    const { root, projectDir } = await claudeRoot();
    await writeFile(
      path.join(projectDir, 'agent-nested.jsonl'),
      `${claudeLine('session-nested', '2026-01-01T00:00:00.000Z', 'nested')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-nested',
    });

    const stats = adapter.nativeSessionReadStats();
    expect(stats.directIdHits).toBe(0);
    expect(stats.directIdFallbacks).toBe(1);
  });

  it('cannot resolve an id the capped list walk never reaches', async () => {
    const { root, projectDir } = await claudeRoot();
    for (let i = 0; i < 12; i += 1) {
      await writeFile(
        path.join(
          projectDir,
          `session-cap-${String(i).padStart(3, '0')}.jsonl`
        ),
        `${claudeLine(
          `session-cap-${String(i).padStart(3, '0')}`,
          '2026-01-01T00:00:00.000Z',
          `turn ${i}`
        )}\n`
      );
    }

    // The by-name walk spends the same maxFiles budget as the list walk, so the
    // set of resolvable ids is exactly the set the list can return.
    const adapter = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      maxFiles: 5,
    });
    const listed = await adapter.listNativeSessions();
    expect(listed).toHaveLength(5);
    const listedIds = new Set(listed.map((sn) => sn.nativeId));

    for (const id of listedIds) {
      await expect(
        adapter.readProviderState({ provider: 'claude', nativeId: id })
      ).resolves.toMatchObject({ ref: { nativeId: id } });
    }

    const unreachable = Array.from(
      { length: 12 },
      (_, i) => `session-cap-${String(i).padStart(3, '0')}`
    ).filter((id) => !listedIds.has(id));
    expect(unreachable.length).toBeGreaterThan(0);
    for (const id of unreachable) {
      await expect(
        adapter.readProviderState({ provider: 'claude', nativeId: id })
      ).rejects.toThrow(/not found/);
    }
  });

  it('resolves a duplicated session id to the same transcript the list walk picks', async () => {
    const { root, projectDir } = await claudeRoot();
    // A nested transcript with the same file name as the top-level one. The
    // list walk reaches the nested copy first (directories are visited in
    // readdir order, interleaved with files), so the by-name walk must too.
    const nestedDir = path.join(projectDir, 'a-nested');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      path.join(nestedDir, 'session-dup.jsonl'),
      `${claudeLine('session-dup', '2026-01-01T00:00:00.000Z', 'nested copy')}\n`
    );
    await writeFile(
      path.join(projectDir, 'session-dup.jsonl'),
      `${claudeLine('session-dup', '2026-01-01T00:00:00.000Z', 'top-level copy')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const walkPick = (await adapter.listNativeSessions()).find(
      (sn) => sn.nativeId === 'session-dup'
    );
    const snapshot = await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-dup',
    });
    expect(snapshot.sourcePath).toBe(walkPick?.sourcePath);
  });

  it('falls back to the full walk when the id is not a file name', async () => {
    const { root, projectDir } = await claudeRoot();
    // The transcript is named after a subagent, not after its session id.
    await writeFile(
      path.join(projectDir, 'agent-deadbeef.jsonl'),
      `${claudeLine('session-inner', '2026-01-01T00:00:00.000Z', 'nested transcript')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const snapshot = await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-inner',
    });
    expect(snapshot.sourcePath).toBe(
      path.join(projectDir, 'agent-deadbeef.jsonl')
    );
  });

  it('falls back to the full walk when the canonically named file is unreadable', async () => {
    const { root, projectDir } = await claudeRoot();
    const sessionDir = path.join(projectDir, 'session-big');
    await mkdir(sessionDir, { recursive: true });
    // Over the 5 MB read limit: the fast path finds it, fails to read it, and
    // must still resolve the id through the walk.
    const filler = 'x'.repeat(6_000_000);
    await writeFile(
      path.join(projectDir, 'session-big.jsonl'),
      `${claudeLine('session-big', '2026-01-01T00:00:00.000Z', filler)}\n`
    );
    await writeFile(
      path.join(sessionDir, 'agent-small.jsonl'),
      `${claudeLine('session-big', '2026-01-01T00:00:00.000Z', 'small sibling')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const snapshot = await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-big',
    });
    expect(snapshot.sourcePath).toBe(
      path.join(sessionDir, 'agent-small.jsonl')
    );
  });

  it('honours a cwd hint: a same-id transcript under another cwd is not a match', async () => {
    const { root, projectDir } = await claudeRoot();
    await writeFile(
      path.join(projectDir, 'session-scoped.jsonl'),
      `${claudeLine('session-scoped', '2026-01-01T00:00:00.000Z', 'in /tmp/repo')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    // The transcript's own cwd is /tmp/repo, so a /tmp/other-repo hint must not
    // resolve it — the fast path has to scope the same way the walk did.
    await expect(
      adapter.readProviderState({
        provider: 'claude',
        nativeId: 'session-scoped',
        cwd: '/tmp/other-repo',
      })
    ).rejects.toThrow(/not found/);

    await expect(
      adapter.readProviderState({
        provider: 'claude',
        nativeId: 'session-scoped',
        cwd: '/tmp/repo',
      })
    ).resolves.toMatchObject({
      sourcePath: path.join(projectDir, 'session-scoped.jsonl'),
    });
  });

  it('rejects a nativeId that tries to escape the state root', async () => {
    const { root, projectDir } = await claudeRoot();
    await writeFile(
      path.join(projectDir, 'session-safe.jsonl'),
      `${claudeLine('session-safe', '2026-01-01T00:00:00.000Z', 'safe')}\n`
    );
    const outside = await mkdtemp(path.join(tmpdir(), 'relay-1449-outside-'));
    await writeFile(
      path.join(outside, 'escape.jsonl'),
      `${claudeLine('escape', '2026-01-01T00:00:00.000Z', 'outside')}\n`
    );

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    await expect(
      adapter.readProviderState({
        provider: 'claude',
        nativeId: path.join('..', '..', path.basename(outside), 'escape'),
      })
    ).rejects.toThrow(/not found/);
    // The decoy is untouched.
    await expect(
      readFile(path.join(outside, 'escape.jsonl'), 'utf8')
    ).resolves.toContain('outside');
  });
});

describe('#1449 streaming scan parity with the read path', () => {
  it('list and read paths agree on a large CRLF transcript with no trailing newline', async () => {
    const { root, projectDir } = await claudeRoot();
    const sessionPath = path.join(projectDir, 'session-chunky.jsonl');

    // > 64 KB so the read stream splits lines (and CRLF pairs) across chunk
    // boundaries, CRLF endings, and no trailing newline on the final record.
    const records: string[] = [
      JSON.stringify({
        type: 'summary',
        summary: 'chunked transcript',
        sessionId: 'session-chunky',
        cwd: '/tmp/repo',
        timestamp: '2026-01-05T00:00:00.000Z',
      }),
    ];
    for (let i = 0; i < 60; i += 1) {
      records.push(
        claudeLine(
          'session-chunky',
          // Deliberately out of order: claude reports sorted first/last.
          `2026-01-0${(i % 9) + 1}T00:00:0${i % 10}.000Z`,
          `padded turn ${i} ${'y'.repeat(2_000)}`
        )
      );
    }
    records.push(
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-chunky',
        timestamp: '2026-01-09T23:59:59.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'considering' },
            { type: 'text', text: 'final answer' },
          ],
        },
      })
    );
    // CRLF line endings, and the last record has no terminator at all.
    await writeFile(sessionPath, records.join('\r\n'));
    expect((await stat(sessionPath)).size).toBeGreaterThan(64 * 1024);

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const [listed] = await adapter.listNativeSessions();
    const snapshot = await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-chunky',
      sourcePath: sessionPath,
    });

    expect(listed?.metadata?.['lineCount']).toBe(records.length);
    expect(snapshot.summary.lineCount).toBe(records.length);
    expect(listed?.metadata?.['hashSha256']).toBe(snapshot.summary.hashSha256);
    expect(listed?.metadata?.['eventTypes']).toEqual(
      snapshot.summary.eventTypes
    );
    expect(listed?.createdAt).toBe(snapshot.summary.firstTimestamp);
    expect(listed?.updatedAt).toBe(snapshot.summary.lastTimestamp);
    // Claude reports sorted first/last, so the earliest record wins even though
    // the document opens with a later summary line.
    expect(listed?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(listed?.updatedAt).toBe('2026-01-09T23:59:59.000Z');
    expect(listed?.preview).toEqual(snapshot.summary.preview);
    expect(listed?.title).toBe('chunked transcript');
    expect(listed?.cwd).toBe('/tmp/repo');
  });

  it('list and read paths agree on a transcript past the event limit', async () => {
    const { root, projectDir } = await claudeRoot();
    const sessionPath = path.join(projectDir, 'session-truncated.jsonl');
    const records: string[] = [];
    // MAX_JSONL_EVENTS is 5,000; go past it so readTruncation is populated.
    for (let i = 0; i < 5_050; i += 1) {
      records.push(
        JSON.stringify({
          type: 'user',
          sessionId: 'session-truncated',
          cwd: '/tmp/repo',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: `turn ${i}` },
        })
      );
    }
    await writeFile(sessionPath, `${records.join('\n')}\n`);

    const adapter = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const [listed] = await adapter.listNativeSessions();
    const snapshot = await adapter.readProviderState({
      provider: 'claude',
      nativeId: 'session-truncated',
      sourcePath: sessionPath,
    });

    expect(listed?.metadata?.['lineCount']).toBe(5_000);
    expect(listed?.metadata?.['readTruncation']).toEqual(
      snapshot.summary.readTruncation
    );
    expect(listed?.metadata?.['readTruncation']).toMatchObject({
      truncated: true,
      reason: 'event-limit',
    });
    expect(listed?.metadata?.['hashSha256']).toBe(snapshot.summary.hashSha256);
  });

  it('list and read paths agree on a Codex transcript with CRLF and no trailing newline', async () => {
    const { root, dayDir } = await codexRoot();
    const sessionPath = path.join(dayDir, 'rollout-chunky.jsonl');
    const records: string[] = [
      JSON.stringify({
        type: 'session.started',
        session_id: 'rollout-chunky',
        cwd: '/tmp/repo',
        summary: 'codex chunked',
        timestamp: '2026-01-05T00:00:00.000Z',
      }),
    ];
    for (let i = 0; i < 60; i += 1) {
      records.push(
        codexLine(
          'rollout-chunky',
          `2026-01-0${(i % 9) + 1}T00:00:0${i % 10}.000Z`,
          `padded turn ${i} ${'y'.repeat(2_000)}`
        )
      );
    }
    await writeFile(sessionPath, records.join('\r\n'));
    expect((await stat(sessionPath)).size).toBeGreaterThan(64 * 1024);

    const adapter = new CodexJsonlStateAdapter({ stateRoot: root });
    const [listed] = await adapter.listNativeSessions();
    const snapshot = await adapter.readProviderState({
      provider: 'codex',
      nativeId: 'rollout-chunky',
      sourcePath: sessionPath,
    });

    expect(listed?.metadata?.['lineCount']).toBe(records.length);
    expect(listed?.metadata?.['hashSha256']).toBe(snapshot.summary.hashSha256);
    expect(listed?.metadata?.['eventTypes']).toEqual(
      snapshot.summary.eventTypes
    );
    // Codex reports document-order first/last, not sorted: the last record is
    // 2026-01-06, while the sorted maximum in this fixture is 2026-01-09.
    expect(listed?.createdAt).toBe('2026-01-05T00:00:00.000Z');
    expect(listed?.updatedAt).toBe('2026-01-06T00:00:09.000Z');
    expect(listed?.preview).toEqual(snapshot.summary.preview);
  });
});

describe('#1449 registry provider fan-out', () => {
  it('keeps provider order and aggregate content when providers run concurrently', async () => {
    const { root: cRoot, projectDir } = await claudeRoot();
    const { root: xRoot, dayDir } = await codexRoot();
    await writeFile(
      path.join(projectDir, 'session-a.jsonl'),
      `${claudeLine('session-a', '2026-01-02T00:00:00.000Z', 'claude turn')}\n`
    );
    await writeFile(
      path.join(dayDir, 'rollout-b.jsonl'),
      `${codexLine('rollout-b', '2026-01-03T00:00:00.000Z', 'codex turn')}\n`
    );

    const registry = new NativeSessionAdapterRegistry();
    registry.register(new ClaudeJsonlStateAdapter({ stateRoot: cRoot }));
    registry.register(new CodexJsonlStateAdapter({ stateRoot: xRoot }));

    const report = await registry.listAllSessions();
    expect(report.providers.map((p) => p.provider)).toEqual([
      'claude',
      'codex',
    ]);
    // Newest first, across providers.
    expect(report.sessions.map((s) => s.nativeId)).toEqual([
      'rollout-b',
      'session-a',
    ]);
  });

  it('still reports an unavailable provider without dropping the healthy one', async () => {
    const { root: cRoot, projectDir } = await claudeRoot();
    await writeFile(
      path.join(projectDir, 'session-a.jsonl'),
      `${claudeLine('session-a', '2026-01-02T00:00:00.000Z', 'claude turn')}\n`
    );

    const registry = new NativeSessionAdapterRegistry();
    registry.register(new ClaudeJsonlStateAdapter({ stateRoot: cRoot }));
    registry.register(
      new CodexJsonlStateAdapter({ stateRoot: '/nonexistent/codex/1449' })
    );

    const report = await registry.listAllSessions();
    expect(report.sessions.map((s) => s.nativeId)).toEqual(['session-a']);
    expect(report.providers.find((p) => p.provider === 'codex')?.status).toBe(
      'unavailable'
    );
  });
});
