import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_REDACTION_RULES,
  redactJson,
  redactText,
} from '../../server/diagnostics-bundle.js';
import { redactBootstrapSecrets } from '../../shared/bootstrap-diagnostics.js';

// ─────────────────────────────────────────────────────────────────────────────
// Manifest <-> fixture consistency gate for the diagnostics bundle redactor.
//
// Issue #598 follow-on to PR #513 / #504: ensures every redaction rule shipped
// by `diagnostics-bundle.ts` has a representative fixture proving it fires,
// and every fixture maps to a known rule. Adding a rule without a fixture (or
// removing a fixture without removing the rule) fails this test loudly.
//
// Bootstrap-diagnostics fixtures (`module: bootstrap-diagnostics`) cover the
// `redactBootstrapSecrets` shapes that flow through routed-PTY error paths
// (#587 / #588) — pair tokens, node credentials, Bearer headers, JSON secret
// keys, secret assignments. The bootstrap redactor has no exported rule list,
// so behavioral assertions only on those fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'redaction');

type Module = 'diagnostics-bundle' | 'bootstrap-diagnostics';

interface Fixture {
  file: string;
  rule: string;
  module: Module;
  redactor: 'redactText' | 'redactJson' | 'redactBootstrapSecrets';
  description: string;
  input: string | unknown;
  inputIsJson: boolean;
  secrets: string[];
  preserves: string[];
}

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  const files = fs.readdirSync(FIXTURE_DIR).sort();
  for (const file of files) {
    const fullPath = path.join(FIXTURE_DIR, file);
    if (file.endsWith('.json')) {
      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as {
        rule: string;
        module: Module;
        redactor: Fixture['redactor'];
        description: string;
        input: unknown;
        secrets: string[];
        preserves: string[];
      };
      fixtures.push({
        file,
        rule: raw.rule,
        module: raw.module,
        redactor: raw.redactor,
        description: raw.description,
        input: raw.input,
        inputIsJson: true,
        secrets: raw.secrets,
        preserves: raw.preserves,
      });
      continue;
    }
    if (file.endsWith('.txt')) {
      fixtures.push(parseTxtFixture(file, fs.readFileSync(fullPath, 'utf8')));
      continue;
    }
  }
  return fixtures;
}

function parseTxtFixture(file: string, body: string): Fixture {
  const metaMatch = body.match(/## meta\n([\s\S]*?)\n## input\n([\s\S]*)$/);
  if (!metaMatch) {
    throw new Error(
      `fixture ${file} must have a '## meta' block followed by '## input'`
    );
  }
  const metaLines = metaMatch[1]!.split('\n');
  const meta: Record<string, string> = {};
  for (const line of metaLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) throw new Error(`fixture ${file} meta line missing colon: ${line}`);
    meta[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  const input = metaMatch[2]!.replace(/\n+$/, '');
  return {
    file,
    rule: requireMeta(file, meta, 'rule'),
    module: requireMeta(file, meta, 'module') as Module,
    redactor: requireMeta(file, meta, 'redactor') as Fixture['redactor'],
    description: requireMeta(file, meta, 'description'),
    input,
    inputIsJson: false,
    secrets: requireMeta(file, meta, 'secrets')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    preserves: requireMeta(file, meta, 'preserves')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function requireMeta(
  file: string,
  meta: Record<string, string>,
  key: string
): string {
  const value = meta[key];
  if (value === undefined || value === '') {
    throw new Error(`fixture ${file} missing required meta key '${key}'`);
  }
  return value;
}

function applyRedactor(fixture: Fixture): {
  output: string;
  counts: Record<string, number>;
} {
  if (fixture.redactor === 'redactJson') {
    const result = redactJson(fixture.input);
    return { output: JSON.stringify(result.value), counts: result.counts };
  }
  const inputText =
    typeof fixture.input === 'string' ? fixture.input : JSON.stringify(fixture.input);
  if (fixture.redactor === 'redactText') {
    const result = redactText(inputText);
    return { output: result.value, counts: result.counts };
  }
  if (fixture.redactor === 'redactBootstrapSecrets') {
    return { output: redactBootstrapSecrets(inputText), counts: {} };
  }
  throw new Error(`fixture ${fixture.file} has unknown redactor ${fixture.redactor}`);
}

const fixtures = loadFixtures();
const fixturesByRule = new Map<string, Fixture[]>();
for (const fixture of fixtures) {
  const list = fixturesByRule.get(fixture.rule) ?? [];
  list.push(fixture);
  fixturesByRule.set(fixture.rule, list);
}

describe('redaction fixture coverage', () => {
  it('loads at least one fixture per registered rule', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(
      DIAGNOSTICS_REDACTION_RULES.length
    );
  });

  for (const fixture of fixtures) {
    it(`scrubs ${fixture.rule} secrets while preserving context (${fixture.file})`, () => {
      const { output, counts } = applyRedactor(fixture);
      for (const secret of fixture.secrets) {
        expect(
          output,
          `fixture ${fixture.file} leaked secret "${secret}" through ${fixture.redactor}`
        ).not.toContain(secret);
      }
      for (const preserved of fixture.preserves) {
        expect(
          output,
          `fixture ${fixture.file} dropped expected non-secret context "${preserved}"`
        ).toContain(preserved);
      }
      // For the bundle redactor, prove the named rule actually fired (no
      // silent fallthrough to a different rule).
      if (fixture.module === 'diagnostics-bundle') {
        expect(
          counts[fixture.rule] ?? 0,
          `fixture ${fixture.file} expected rule '${fixture.rule}' to fire but counts=${JSON.stringify(
            counts
          )}`
        ).toBeGreaterThan(0);
      }
    });
  }
});

describe('redaction manifest <-> fixture consistency gate', () => {
  it('every DIAGNOSTICS_REDACTION_RULES entry has at least one fixture', () => {
    const missing: string[] = [];
    for (const rule of DIAGNOSTICS_REDACTION_RULES) {
      const matched = fixturesByRule.get(rule.id) ?? [];
      const fromBundle = matched.filter((f) => f.module === 'diagnostics-bundle');
      if (fromBundle.length === 0) missing.push(rule.id);
    }
    expect(
      missing,
      `missing diagnostics-bundle fixtures for rules: ${missing.join(', ')}. ` +
        `Add test/fixtures/redaction/<rule>.{txt,json} with module=diagnostics-bundle.`
    ).toEqual([]);
  });

  it('every diagnostics-bundle fixture maps to a registered rule', () => {
    const known = new Set(DIAGNOSTICS_REDACTION_RULES.map((rule) => rule.id));
    const orphaned: string[] = [];
    for (const fixture of fixtures) {
      if (fixture.module !== 'diagnostics-bundle') continue;
      if (!known.has(fixture.rule)) orphaned.push(`${fixture.file}#${fixture.rule}`);
    }
    expect(
      orphaned,
      `fixtures reference unknown diagnostics-bundle rules: ${orphaned.join(', ')}. ` +
        `Either add the rule to DIAGNOSTICS_REDACTION_RULES or remove the fixture.`
    ).toEqual([]);
  });

  it('every bootstrap-diagnostics fixture is actually scrubbed by redactBootstrapSecrets', () => {
    // Bootstrap redactor has no exported rule list, so this is the closest we
    // can get to a manifest gate: every fixture tagged bootstrap-diagnostics
    // must round-trip with all declared secrets removed.
    const leaks: string[] = [];
    for (const fixture of fixtures) {
      if (fixture.module !== 'bootstrap-diagnostics') continue;
      const text =
        typeof fixture.input === 'string'
          ? fixture.input
          : JSON.stringify(fixture.input);
      const output = redactBootstrapSecrets(text);
      for (const secret of fixture.secrets) {
        if (output.includes(secret)) leaks.push(`${fixture.file}:${secret}`);
      }
    }
    expect(
      leaks,
      `bootstrap-diagnostics fixtures leaked secrets through redactBootstrapSecrets: ${leaks.join(', ')}`
    ).toEqual([]);
  });
});

describe('routed-PTY / node-link log shapes (#587, #588) are covered by redaction', () => {
  // Sanity-check the specific log line shapes emitted by node-link-client,
  // node-link-rpc-host, and node-link-pty-host. If any of these regress to
  // emit raw secret content and the redactor stops catching it, this test
  // tells you which log path is now leaking.

  it('redacts http(s) URL-embedded credentials in "connected to <linkUrl>" lines (covers the http/https half of node-link-client.ts:411)', () => {
    const raw =
      "[node-link] connected to https://relayuser:FAKE_URL_PASS_aaaaaaaa@hub.example.test/hub/node-link";
    const out = redactText(raw).value;
    expect(out).not.toContain('FAKE_URL_PASS_aaaaaaaa');
    expect(out).not.toContain('relayuser');
    expect(out).toContain('hub.example.test');
  });

  // Known gap tracked as issue #604: the diag bundle url-credential regex
  // only matches https?:// URLs, but node-link-client logs the WS variant
  // (wss://). When that's fixed, this it.fails flips green and forces us
  // to retire the .fails marker — exactly the regression behavior we want.
  it.fails(
    'redacts ws(s) URL-embedded credentials in "connected to <linkUrl>" lines — see issue #604',
    () => {
      const raw =
        "[node-link] connected to wss://relayuser:FAKE_URL_PASS_aaaaaaaa@hub.example.test/hub/node-link";
      const out = redactText(raw).value;
      expect(out).not.toContain('FAKE_URL_PASS_aaaaaaaa');
      expect(out).not.toContain('relayuser');
      expect(out).toContain('hub.example.test');
    }
  );

  it('redacts Authorization headers if a node-link RPC error path echoes request headers', () => {
    const raw =
      "[node-link-rpc] sessions.create failed: upstream rejected Authorization: Bearer tok_FAKE_aaaaaaaa";
    const out = redactText(raw).value;
    expect(out).not.toContain('tok_FAKE_aaaaaaaa');
    expect(out).toContain('sessions.create failed');
  });

  it('redacts pair tokens echoed in routed-PTY bootstrap diagnostics (#588)', () => {
    const raw =
      "[node-link-pty] pty attach failed (stream-1): node connect failed for --pair-token pair_FAKE_PAIR_aaaaaaaa";
    const out = redactBootstrapSecrets(raw);
    expect(out).not.toContain('pair_FAKE_PAIR_aaaaaaaa');
    expect(out).toContain('pty attach failed');
  });

  it('redacts node credential token shapes echoed in credential.rotate errors', () => {
    const raw =
      "[node-link-rpc] credential.rotate failed: persistence rejected node_FAKE_NODE_aaaa.secret_FAKE_TOKEN_bbbb";
    const out = redactBootstrapSecrets(raw);
    expect(out).not.toContain('node_FAKE_NODE_aaaa.secret_FAKE_TOKEN_bbbb');
    expect(out).not.toContain('secret_FAKE_TOKEN_bbbb');
    expect(out).toContain('credential.rotate failed');
  });
});
