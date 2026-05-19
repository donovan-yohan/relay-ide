// @vitest-environment happy-dom

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { SecurityAuditPanel } from '../../frontend/src/components/SecurityAuditPanel.js';
import type {
  SecurityAuditEntriesResponse,
  SecurityAuditVerifyResponse,
} from '../../frontend/src/lib/api.js';

function makeEntry(seq: number): SecurityAuditEntriesResponse['entries'][0] {
  return {
    eventId: `evt-${seq}`,
    timestamp: '2026-05-19T10:00:00.000Z',
    sequence: seq,
    schemaVersion: 1,
    eventType: 'grant',
    decision: 'allow',
    reasonCode: 'ACL_ALLOWED',
    peer: { kind: 'node', nodeId: 'node-1' },
    node: { nodeId: 'node-1', trustTier: 'dev' },
    intent: { action: 'rpc.fs.read', target: '/repo' },
    scopeHash: 'a'.repeat(64),
    paramsHash: 'b'.repeat(64),
    requiredBits: ['rpc:fs:read'],
    grantedBits: ['rpc:fs:read'],
    deniedBits: [],
    correlationId: 'corr-1',
    prevHash: seq === 1 ? null : 'c'.repeat(64),
    entryHash: 'd'.repeat(64),
  };
}

function render(
  entriesPages: SecurityAuditEntriesResponse[],
  verifyResult?: SecurityAuditVerifyResponse
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  // Pre-seed the infinite query cache
  queryClient.setQueryData(
    ['security-audit'],
    {
      pages: entriesPages,
      pageParams: entriesPages.map((_, i) => (i === 0 ? null : entriesPages[i - 1].nextBeforeSequence)),
    }
  );

  if (verifyResult) {
    // key is ['security-audit-verify', latestSequence] — derive from first page head
    const latestSequence = entriesPages[0]?.head.latestSequence ?? 0;
    queryClient.setQueryData(['security-audit-verify', latestSequence], verifyResult);
  }

  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(SecurityAuditPanel)
    )
  );
}

describe('SecurityAuditPanel', () => {
  it('renders empty state with lowercase "no audit entries yet"', () => {
    const html = render([
      { entries: [], nextBeforeSequence: null, head: { latestSequence: 0, latestHash: null } },
    ]);
    expect(html).toContain('no audit entries yet');
    expect(html).not.toContain('No audit entries yet');
  });

  it('renders table rows when entries are present', () => {
    const html = render([
      {
        entries: [makeEntry(1), makeEntry(2)],
        nextBeforeSequence: null,
        head: { latestSequence: 2, latestHash: 'd'.repeat(64) },
      },
    ]);
    // sequence numbers appear in seq column
    expect(html).toContain('>1<');
    expect(html).toContain('>2<');
    expect(html).toContain('rpc.fs.read');
    expect(html).toContain('allow');
    // 2 entries shown in header
    expect(html).toContain('2 entries');
  });

  it('shows [ok] when verify returns ok:true', () => {
    const html = render(
      [
        {
          entries: [makeEntry(1)],
          nextBeforeSequence: null,
          head: { latestSequence: 1, latestHash: 'd'.repeat(64) },
        },
      ],
      { ok: true, entriesVerified: 1, lastHash: 'd'.repeat(64) }
    );
    expect(html).toContain('[ok]');
    expect(html).not.toContain('[break]');
  });

  it('shows [break] when verify returns ok:false', () => {
    const html = render(
      [
        {
          entries: [makeEntry(1)],
          nextBeforeSequence: null,
          head: { latestSequence: 1, latestHash: 'd'.repeat(64) },
        },
      ],
      {
        ok: false,
        entriesVerified: 0,
        lastHash: null,
        break: { sequence: 1, reason: 'entry_hash_mismatch' },
      }
    );
    expect(html).toContain('[break]');
    expect(html).not.toContain('[ok]');
  });

  it('disables "load older" button when nextBeforeSequence is null', () => {
    const html = render([
      {
        entries: [makeEntry(1)],
        nextBeforeSequence: null,
        head: { latestSequence: 1, latestHash: 'd'.repeat(64) },
      },
    ]);
    // The button should have the disabled attribute
    expect(html).toContain('load older entries');
    expect(html).toContain('disabled');
  });

  it('contains no emoji in rendered html', () => {
    const html = render([
      {
        entries: [makeEntry(1), makeEntry(2)],
        nextBeforeSequence: 2,
        head: { latestSequence: 5, latestHash: 'd'.repeat(64) },
      },
    ]);
    // Match emoji range (basic unicode emoji block)
    expect(html).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('does not contain credentialId in rendered output', () => {
    const html = render([
      {
        entries: [makeEntry(1)],
        nextBeforeSequence: null,
        head: { latestSequence: 1, latestHash: 'd'.repeat(64) },
      },
    ]);
    expect(html).not.toMatch(/credentialId|credential_id|token|bearer|secret/i);
  });
});
