import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifySecurityAuditWriteFailure,
  hashAuditMaterial,
  redactAuditValue,
  securityAuditEntryForTabControlEvent,
  SECURITY_AUDIT_EVENT_TYPES,
  type SecurityAuditEntryInput,
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
      controlMode: 'co-driven',
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
        modeBefore: 'agent-driven',
        modeAfter: 'co-driven',
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
      modeBefore: 'agent-driven',
      modeAfter: 'co-driven',
    });
    expect(JSON.stringify(entry)).not.toContain(rawTypedInput);
    expect(fs.readFileSync(dbPath, 'utf8')).not.toContain(rawTypedInput);
  });

  it('marks agent-driven mode restore audit entries with only the mode-set capability', () => {
    const entry = securityAuditEntryForTabControlEvent({
      eventId: 'mode-evt-1',
      type: 'tab.mode-changed',
      occurredAt: '2026-05-16T00:00:01.000Z',
      identity: { nodeId: 'node-a', sessionId: 'session-a', cwd: '/repo' },
      actor: { kind: 'agent', id: 'worker-1', nodeId: 'node-a' },
      reason: 'hand-back',
      previousControlMode: 'co-driven',
      controlMode: 'agent-driven',
    });

    expect(entry.requiredBits).toEqual(['tab:mode:set-agent']);
    expect(entry.grantedBits).toEqual(['tab:mode:set-agent']);
    expect(entry.deniedBits).toEqual([]);
    expect(entry.requiredBits).not.toEqual(
      expect.arrayContaining(['rpc:fs:write', 'rpc:git:write', 'pty:exec:arbitrary'])
    );
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
    expect(() =>
      reopened.append(sampleEvent({ eventId: 'evt-4' }))
    ).toThrow(/checkpoint mismatch/);
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
