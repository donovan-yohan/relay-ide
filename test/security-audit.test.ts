import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifySecurityAuditWriteFailure,
  hashAuditMaterial,
  redactAuditValue,
  redactPeerForBrowser,
  securityAuditEntryForTabControlEvent,
  SECURITY_AUDIT_EVENT_TYPES,
  type SecurityAuditEntryInput,
  type SecurityAuditPeerIdentity,
} from '../shared/security-audit.js';
import {
  SecurityAuditLog,
  verifySecurityAuditLog,
} from '../server/security-audit-log.js';

const tmpRoots: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-security-audit-'));
  tmpRoots.push(dir);
  return path.join(dir, 'audit.db');
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleEvent(
  overrides: Partial<SecurityAuditEntryInput> = {}
): SecurityAuditEntryInput {
  return {
    eventId: overrides.eventId,
    timestamp: overrides.timestamp,
    eventType: overrides.eventType ?? 'grant',
    decision: overrides.decision ?? 'allow',
    reasonCode: overrides.reasonCode ?? 'ACL_ALLOWED',
    peer: overrides.peer ?? {
      kind: 'node',
      nodeId: 'node-1',
      credentialId: 'cred-1',
      displayName: 'Mac Studio',
    },
    node: overrides.node ?? { nodeId: 'node-1', trustTier: 'dev' },
    sessionId: overrides.sessionId ?? 'session-1',
    intent: overrides.intent ?? {
      action: 'rpc.fs.read',
      target: '/repo/README.md',
    },
    material: overrides.material ?? {
      scope: { kind: 'path', pathPrefixes: ['/repo'] },
      params: { path: '/repo/README.md' },
    },
    requiredBits: overrides.requiredBits ?? ['rpc:fs:read'],
    grantedBits: overrides.grantedBits ?? ['rpc:fs:read'],
    deniedBits: overrides.deniedBits ?? [],
    refs: overrides.refs ?? { aclRef: 'acl:node-1:1.0', policyVersion: '1.0' },
    correlationId: overrides.correlationId ?? 'corr-1',
  };
}

describe('security audit primitives', () => {
  it('covers the required security event vocabulary', () => {
    expect(SECURITY_AUDIT_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'grant',
        'denial',
        'challenge',
        'approval',
        'expiry',
        'revocation',
        'rotation',
        'failed_redemption',
        'same_session_approval_attempt',
        'bridge_event',
      ])
    );
  });

  it('normalizes entries with sequence/hash chain fields', () => {
    const log = new SecurityAuditLog(tmpDbPath());
    const first = log.append(
      sampleEvent({ eventId: 'evt-1', correlationId: 'corr-a' })
    );
    const second = log.append(
      sampleEvent({
        eventId: 'evt-2',
        correlationId: 'corr-a',
        eventType: 'denial',
        decision: 'deny',
        reasonCode: 'ACL_DENIED',
        grantedBits: [],
        deniedBits: ['rpc:fs:write'],
      })
    );

    expect(first.sequence).toBe(1);
    expect(first.prevHash).toBeNull();
    expect(first.entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sequence).toBe(2);
    expect(second.prevHash).toBe(first.entryHash);
    expect(second).toMatchObject({
      eventId: 'evt-2',
      schemaVersion: 1,
      eventType: 'denial',
      decision: 'deny',
      reasonCode: 'ACL_DENIED',
      peer: { nodeId: 'node-1', credentialId: 'cred-1' },
      node: { nodeId: 'node-1', trustTier: 'dev' },
      sessionId: 'session-1',
      intent: { action: 'rpc.fs.read' },
      requiredBits: ['rpc:fs:read'],
      deniedBits: ['rpc:fs:write'],
      aclRef: 'acl:node-1:1.0',
      policyVersion: '1.0',
      correlationId: 'corr-a',
    });
    expect(log.verify()).toMatchObject({ ok: true, entriesVerified: 2 });
    log.close();
  });

  it('opens the audit database with WAL and NORMAL synchronous mode', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    log.append(sampleEvent({ eventId: 'evt-sync' }));
    log.close();

    const db = new Database(dbPath);
    try {
      const journalMode = db.pragma('journal_mode', { simple: true });
      const synchronous = db.pragma('synchronous', { simple: true });
      expect(journalMode).toBe('wal');
      expect(synchronous).toBe(1);
    } finally {
      db.close();
    }
  });

  it('redacts tokens, env values, file bytes, and terminal streams before hashing', () => {
    const payload = {
      authorization: 'Bearer relay-secret-token-1234567890',
      bearerToken: 'bearer-token-raw',
      nodeBearerToken: 'node-bearer-token-raw',
      accessToken: 'access-token-raw',
      authToken: 'auth-token-raw',
      pairToken: 'pair-secret',
      confirmationToken: 'confirm-secret',
      env: { GITHUB_TOKEN: 'ghp_ab...7890', SAFE: 'not stored either' },
      fileBytes: Buffer.from('super secret file'),
      terminalBytes: '\u001b[31mraw transcript with ***\u001b[0m',
      nested: { note: 'keep ordinary text' },
    };

    const redacted = redactAuditValue(payload);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain('relay-secret-token');
    expect(serialized).not.toContain('bearer-token-raw');
    expect(serialized).not.toContain('node-bearer-token-raw');
    expect(serialized).not.toContain('access-token-raw');
    expect(serialized).not.toContain('auth-token-raw');
    expect(serialized).not.toContain('pair-secret');
    expect(serialized).not.toContain('confirm-secret');
    expect(serialized).not.toContain('ghp_abcdef');
    expect(serialized).not.toContain('super secret file');
    expect(serialized).not.toContain('sk-live-secret');
    expect(serialized).toContain('keep ordinary text');
    expect(hashAuditMaterial(payload)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redacts circular arrays without recursing forever', () => {
    const circular: unknown[] = ['keep'];
    circular.push(circular);

    expect(redactAuditValue(circular)).toEqual(['keep', '[Circular]']);
    expect(hashAuditMaterial(circular)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not persist raw sensitive material in audit rows', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    log.append(
      sampleEvent({
        material: {
          scope: { kind: 'path', pathPrefixes: ['/secret'] },
          params: {
            pairToken: 'raw-pair-token',
            stdout: 'terminal stream',
            env: { SECRET_KEY: 'raw-env-secret' },
          },
        },
      })
    );
    log.close();

    const bytes = fs.readFileSync(dbPath, 'utf8');
    expect(bytes).not.toContain('raw-pair-token');
    expect(bytes).not.toContain('terminal stream');
    expect(bytes).not.toContain('raw-env-secret');
  });

  it('correlates tab control events without copying raw intervention payloads', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    const rawTypedInput = 'deploy --token raw-control-secret';
    const entry = securityAuditEntryForTabControlEvent({
      eventId: 'intervention-evt-1',
      type: 'tab.intervention',
      occurredAt: '2026-05-16T00:00:00.000Z',
      identity: {
        nodeId: 'node-a',
        sessionId: 'session-a',
        globalSessionId: 'node-a:session-a',
        cwd: '/repo',
      },
      actor: { kind: 'human', id: 'operator-a', displayName: 'operator' },
      reason: 'human input',
      controlMode: 'human-driven',
      intervention: {
        id: 'intervention-evt-1',
        sessionId: 'session-a',
        tabId: 'node-a:session-a',
        nodeId: 'node-a',
        globalSessionId: 'node-a:session-a',
        cwd: '/repo',
        timestamp: '2026-05-16T00:00:00.000Z',
        author: { kind: 'human', id: 'operator-a', displayName: 'operator' },
        source: 'pty-input',
        kind: 'human-input',
        payloadPreview: rawTypedInput,
        redaction: {
          redacted: true,
          byteCount: rawTypedInput.length,
          charCount: rawTypedInput.length,
          lineCount: 1,
          hashSha256: 'abc123',
          classes: ['secret-like'],
        },
        modeBefore: 'human-driven',
        modeAfter: 'human-driven',
      },
    });

    const persisted = log.append(entry);
    log.close();

    expect(persisted).toMatchObject({
      eventId: 'intervention-evt-1',
      eventType: 'bridge_event',
      decision: 'recorded',
      reasonCode: 'TAB_INTERVENTION_RECORDED',
      node: { nodeId: 'node-a' },
      sessionId: 'session-a',
      intent: { action: 'tab.intervention', target: 'node-a:session-a' },
      correlationId: 'intervention-evt-1',
      requiredBits: [],
      grantedBits: [],
    });
    expect(entry.material.params).toMatchObject({
      sourceEventId: 'intervention-evt-1',
      interventionKind: 'human-input',
      interventionSource: 'pty-input',
      payload: { hashSha256: 'abc123', classes: ['secret-like'] },
      modeBefore: 'human-driven',
      modeAfter: 'human-driven',
    });
    expect(JSON.stringify(entry)).not.toContain(rawTypedInput);
    expect(fs.readFileSync(dbPath, 'utf8')).not.toContain(rawTypedInput);
  });

  it('verifies a clean append-only chain', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    log.append(sampleEvent({ eventId: 'evt-1' }));
    log.append(sampleEvent({ eventId: 'evt-2', correlationId: 'corr-2' }));
    log.close();

    expect(verifySecurityAuditLog(dbPath)).toMatchObject({
      ok: true,
      entriesVerified: 2,
    });
  });

  it('enforces append-only persistence through triggers', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    log.append(sampleEvent({ eventId: 'evt-1' }));
    log.close();

    const db = new Database(dbPath);
    expect(() => db.prepare('DELETE FROM security_audit_log').run()).toThrow(
      /append-only/
    );
    expect(() =>
      db.prepare("UPDATE security_audit_log SET decision = 'deny'").run()
    ).toThrow(/append-only/);
    db.close();
  });

  it('detects tamper with exact break location', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    log.append(sampleEvent({ eventId: 'evt-1' }));
    log.append(sampleEvent({ eventId: 'evt-2' }));
    log.close();

    const db = new Database(dbPath);
    db.exec('DROP TRIGGER security_audit_no_update');
    db.prepare(
      "UPDATE security_audit_log SET decision = 'deny' WHERE sequence = 2"
    ).run();
    db.close();

    expect(verifySecurityAuditLog(dbPath)).toMatchObject({
      ok: false,
      entriesVerified: 1,
      break: { sequence: 2, eventId: 'evt-2', reason: 'entry_hash_mismatch' },
    });
  });

  it('detects delete/reorder gaps with exact break location', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    log.append(sampleEvent({ eventId: 'evt-1' }));
    log.append(sampleEvent({ eventId: 'evt-2' }));
    log.append(sampleEvent({ eventId: 'evt-3' }));
    log.close();

    const db = new Database(dbPath);
    db.exec('DROP TRIGGER security_audit_no_delete');
    db.prepare('DELETE FROM security_audit_log WHERE sequence = 2').run();
    db.close();

    expect(verifySecurityAuditLog(dbPath)).toMatchObject({
      ok: false,
      entriesVerified: 1,
      break: { sequence: 2, eventId: 'evt-3', reason: 'sequence_gap' },
    });
  });

  it('detects tail truncation against the stored checkpoint', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    log.append(sampleEvent({ eventId: 'evt-1' }));
    log.append(sampleEvent({ eventId: 'evt-2' }));
    log.append(sampleEvent({ eventId: 'evt-3' }));
    log.close();

    const db = new Database(dbPath);
    db.exec('DROP TRIGGER security_audit_no_delete');
    db.prepare('DELETE FROM security_audit_log WHERE sequence = 3').run();
    db.close();

    expect(verifySecurityAuditLog(dbPath)).toMatchObject({
      ok: false,
      entriesVerified: 2,
      break: {
        sequence: 3,
        reason: 'tail_checkpoint_mismatch',
        expected: 3,
        actual: 2,
      },
    });
  });

  it('does not launder tail truncation when appending after deletion', () => {
    const dbPath = tmpDbPath();
    const log = new SecurityAuditLog(dbPath);
    log.append(sampleEvent({ eventId: 'evt-1' }));
    log.append(sampleEvent({ eventId: 'evt-2' }));
    log.append(sampleEvent({ eventId: 'evt-3' }));
    log.close();

    const db = new Database(dbPath);
    db.exec('DROP TRIGGER security_audit_no_delete');
    db.prepare('DELETE FROM security_audit_log WHERE sequence = 3').run();
    db.close();

    const reopened = new SecurityAuditLog(dbPath);
    expect(() => reopened.append(sampleEvent({ eventId: 'evt-4' }))).toThrow(
      /checkpoint mismatch/
    );
    reopened.close();

    expect(verifySecurityAuditLog(dbPath)).toMatchObject({
      ok: false,
      entriesVerified: 2,
      break: {
        sequence: 3,
        reason: 'tail_checkpoint_mismatch',
        expected: 3,
        actual: 2,
      },
    });
  });

  it('reports corrupt or partial storage instead of silently trusting it', () => {
    const dbPath = tmpDbPath();
    fs.writeFileSync(dbPath, 'not a sqlite database');

    expect(verifySecurityAuditLog(dbPath)).toMatchObject({
      ok: false,
      entriesVerified: 0,
      break: { sequence: 0, reason: 'storage_corrupt' },
    });
  });

  describe('listBefore', () => {
    it('returns empty rows and null nextBeforeSequence for an empty db', () => {
      const log = new SecurityAuditLog(tmpDbPath());
      const result = log.listBefore(null, 50);
      expect(result.rows).toEqual([]);
      expect(result.nextBeforeSequence).toBeNull();
      log.close();
    });

    it('returns newest N rows first when called with null (from head)', () => {
      const log = new SecurityAuditLog(tmpDbPath());
      for (let i = 1; i <= 5; i++) {
        log.append(
          sampleEvent({ eventId: `evt-${i}`, correlationId: `corr-${i}` })
        );
      }
      const result = log.listBefore(null, 3);
      expect(result.rows).toHaveLength(3);
      // newest-first: sequences 5, 4, 3
      expect(result.rows[0].sequence).toBe(5);
      expect(result.rows[2].sequence).toBe(3);
      expect(result.nextBeforeSequence).toBe(3);
      log.close();
    });

    it('paginates correctly: listBefore(3, 100) returns rows 2,1 with nextBeforeSequence:1; listBefore(1,100) returns empty+null', () => {
      const log = new SecurityAuditLog(tmpDbPath());
      for (let i = 1; i <= 5; i++) {
        log.append(
          sampleEvent({ eventId: `evt-${i}`, correlationId: `corr-${i}` })
        );
      }
      const result = log.listBefore(3, 100);
      expect(result.rows).toHaveLength(2);
      // DESC: sequences 2, 1
      expect(result.rows[0].sequence).toBe(2);
      expect(result.rows[1].sequence).toBe(1);
      expect(result.nextBeforeSequence).toBe(1);

      // fetching before sequence 1 returns empty + null (terminal page)
      const terminal = log.listBefore(1, 100);
      expect(terminal.rows).toHaveLength(0);
      expect(terminal.nextBeforeSequence).toBeNull();
      log.close();
    });

    it('caps limit at 200 when limit > 200 is requested', () => {
      const log = new SecurityAuditLog(tmpDbPath());
      for (let i = 1; i <= 5; i++) {
        log.append(
          sampleEvent({ eventId: `evt-${i}`, correlationId: `corr-${i}` })
        );
      }
      // Should not throw; limit capped at 200 internally
      const result = log.listBefore(null, 9999);
      expect(result.rows).toHaveLength(5);
      log.close();
    });

    it('throws for negative beforeSequence', () => {
      const log = new SecurityAuditLog(tmpDbPath());
      expect(() => log.listBefore(-1, 50)).toThrow(
        /beforeSequence must be a non-negative finite number or null/
      );
      log.close();
    });

    it('throws for non-finite beforeSequence', () => {
      const log = new SecurityAuditLog(tmpDbPath());
      expect(() => log.listBefore(Infinity, 50)).toThrow(
        /beforeSequence must be a non-negative finite number or null/
      );
      log.close();
    });
  });

  describe('head', () => {
    it('returns latestSequence 0 and null latestHash for an empty db', () => {
      const log = new SecurityAuditLog(tmpDbPath());
      const h = log.head();
      expect(h).toEqual({ latestSequence: 0, latestHash: null });
      log.close();
    });

    it('returns the checkpoint values matching verify().lastHash after appends', () => {
      const log = new SecurityAuditLog(tmpDbPath());
      log.append(sampleEvent({ eventId: 'evt-1' }));
      const second = log.append(
        sampleEvent({ eventId: 'evt-2', correlationId: 'corr-2' })
      );
      const h = log.head();
      const v = log.verify();
      expect(h.latestSequence).toBe(2);
      expect(h.latestHash).toBe(second.entryHash);
      expect(h.latestHash).toBe(v.lastHash);
      log.close();
    });
  });

  it('classifies audit write failures as closed for prod/destructive and degraded for low-tier reads', () => {
    expect(
      classifySecurityAuditWriteFailure({
        trustTier: 'prod',
        requiredBits: ['session:read'],
      })
    ).toMatchObject({ mode: 'fail-closed' });
    expect(
      classifySecurityAuditWriteFailure({
        trustTier: 'dev',
        requiredBits: ['rpc:fs:write'],
      })
    ).toMatchObject({ mode: 'fail-closed' });
    expect(
      classifySecurityAuditWriteFailure({
        trustTier: 'sandbox',
        requiredBits: ['rpc:fs:read'],
      })
    ).toMatchObject({ mode: 'degraded' });
  });
});

describe('redactPeerForBrowser', () => {
  it('removes credentialId from a peer object', () => {
    const peer: SecurityAuditPeerIdentity = {
      kind: 'node',
      nodeId: 'node-1',
      credentialId: 'cred-secret-xyz',
      displayName: 'Test Node',
    };
    const result = redactPeerForBrowser(peer);
    expect(result).not.toHaveProperty('credentialId');
    expect(result.nodeId).toBe('node-1');
    expect(result.displayName).toBe('Test Node');
    expect(result.kind).toBe('node');
  });

  it('does not mutate the original peer object (pure function)', () => {
    const peer: SecurityAuditPeerIdentity = {
      kind: 'node',
      nodeId: 'node-2',
      credentialId: 'cred-should-remain',
    };
    redactPeerForBrowser(peer);
    expect(peer.credentialId).toBeDefined();
    expect(peer.credentialId).toBe('cred-should-remain');
  });

  it('is idempotent: passing an already-redacted peer returns an equivalent object without credentialId', () => {
    const peer: SecurityAuditPeerIdentity = {
      kind: 'node',
      nodeId: 'node-3',
      displayName: 'already clean',
    };
    const once = redactPeerForBrowser(peer);
    const twice = redactPeerForBrowser(once);
    expect(twice).not.toHaveProperty('credentialId');
    expect(twice.nodeId).toBe('node-3');
    expect(twice.displayName).toBe('already clean');
  });
});
