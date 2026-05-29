import * as crypto from 'node:crypto';
import type { Request } from 'express';
import type {
  RelayNodeSourceDiagnostics,
  RelayNodeSourceState,
} from '../shared/relay-node-protocol.js';

export interface RelayNodeSourceTuple {
  tailnetIp?: string;
  magicDnsName?: string;
  hostname?: string;
}

export interface RelayNodeSourceEvaluation {
  diagnostics: RelayNodeSourceDiagnostics;
  normalizedObserved?: RelayNodeSourceTuple | undefined;
  observedFingerprint?: string | undefined;
  matchesExpected: boolean;
}

const MAGICDNS_SUFFIX_PATTERN = /(^|\.)ts\.net$/i;
const MAGICDNS_LEGACY_SUFFIX_PATTERN = /(^|\.)beta\.tailscale\.net$/i;
const SOURCE_HEADER_NAMES = {
  tailnetIp: [
    'x-relay-node-tailnet-ip',
    'x-relay-tailnet-ip',
    'x-tailscale-ip',
  ],
  magicDnsName: [
    'x-relay-node-magicdns-name',
    'x-relay-magicdns-name',
    'x-tailscale-magicdns-name',
  ],
} as const;

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function firstHeader(req: Request, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = req.header(name);
    const first = value?.split(',')[0]?.trim();
    if (first) return first;
  }
  return undefined;
}

function normalizeIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withoutIpv6Prefix = /^::ffff:/i.test(trimmed)
    ? trimmed.slice('::ffff:'.length)
    : trimmed;
  return isTailscaleIp(withoutIpv6Prefix) ? withoutIpv6Prefix.toLowerCase() : undefined;
}

function isTailscaleIp(value: string): boolean {
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return false;
    }
    return octets[0]! === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  }
  return value.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

function normalizeDnsName(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\.$/, '').toLowerCase();
  if (!trimmed || trimmed.length > 253) return undefined;
  if (
    !MAGICDNS_SUFFIX_PATTERN.test(trimmed) &&
    !MAGICDNS_LEGACY_SUFFIX_PATTERN.test(trimmed)
  ) {
    return undefined;
  }
  const labels = trimmed.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-')
    )
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizeHostname(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\.$/, '').toLowerCase();
  if (!trimmed || trimmed.length > 253) return undefined;
  if (!/^[a-z0-9._-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

export function normalizeRelayNodeSourceTuple(
  source: RelayNodeSourceTuple | undefined
): RelayNodeSourceTuple | undefined {
  const tailnetIp = normalizeIp(source?.tailnetIp);
  const magicDnsName = normalizeDnsName(source?.magicDnsName);
  const hostname = normalizeHostname(source?.hostname);
  const normalized: RelayNodeSourceTuple = {
    ...(tailnetIp ? { tailnetIp } : {}),
    ...(magicDnsName ? { magicDnsName } : {}),
    ...(hostname ? { hostname } : {}),
  };
  return hasTailscaleSourceSignal(normalized) || normalized.hostname
    ? normalized
    : undefined;
}

export function sourceTupleWithHostname(
  source: RelayNodeSourceTuple | undefined,
  hostname: string | undefined
): RelayNodeSourceTuple | undefined {
  return normalizeRelayNodeSourceTuple({
    ...(source ?? {}),
    ...(hostname ? { hostname } : {}),
  });
}

export function sourceTupleFromRequest(req: Request): RelayNodeSourceTuple | undefined {
  const remoteAddress = req.socket.remoteAddress ?? req.ip;
  const tailnetIp =
    firstHeader(req, SOURCE_HEADER_NAMES.tailnetIp) ?? normalizeIp(remoteAddress);
  const magicDnsName = firstHeader(req, SOURCE_HEADER_NAMES.magicDnsName);
  return normalizeRelayNodeSourceTuple({
    ...(tailnetIp ? { tailnetIp } : {}),
    ...(magicDnsName ? { magicDnsName } : {}),
  });
}

export function hasTailscaleSourceSignal(
  source: RelayNodeSourceTuple | undefined
): boolean {
  return Boolean(source?.tailnetIp || source?.magicDnsName);
}

export function sourceFingerprint(
  source: RelayNodeSourceTuple,
  fingerprintKey = 'relay-node-source-fingerprint-v1'
): string {
  const material = {
    ...(source.tailnetIp ? { tailnetIp: source.tailnetIp } : {}),
    ...(source.magicDnsName ? { magicDnsName: source.magicDnsName } : {}),
    ...(source.hostname ? { hostname: source.hostname } : {}),
  };
  return `src_${crypto
    .createHmac('sha256', fingerprintKey)
    .update(stableJson(material))
    .digest('hex')
    .slice(0, 32)}`;
}

function lossyIpHint(ip: string): string {
  if (ip.includes('.')) {
    const [a] = ip.split('.');
    return `${a}.x.x.x`;
  }
  return `${ip.split(':')[0]}:…`;
}

function lossyDnsHint(name: string, fingerprint?: string): string {
  const suffix = name.endsWith('.beta.tailscale.net') ? 'beta.tailscale.net' : 'ts.net';
  return `${suffix}:${(fingerprint ?? 'src_unknown').slice(-8)}`;
}

export function sourceDisplayHint(
  source: RelayNodeSourceTuple | undefined,
  fingerprint?: string
): string {
  if (source?.tailnetIp) return `tailscale-ip:${lossyIpHint(source.tailnetIp)}`;
  if (source?.magicDnsName) return `magicdns:${lossyDnsHint(source.magicDnsName, fingerprint)}`;
  if (source?.hostname || fingerprint) return `hostname:${(fingerprint ?? sourceFingerprint(source!)).slice(-8)}`;
  return 'no tailscale/magicdns signal';
}

export function sourcesMatch(
  expected: RelayNodeSourceTuple | undefined,
  observed: RelayNodeSourceTuple | undefined
): boolean {
  if (!expected || !observed) return false;
  const comparable: (keyof RelayNodeSourceTuple)[] = ['tailnetIp', 'magicDnsName'];
  for (const key of comparable) {
    if (expected[key] && observed[key] && expected[key] === observed[key]) {
      return true;
    }
  }
  return false;
}

export function evaluateRelayNodeSource(input: {
  expected?: RelayNodeSourceTuple | undefined;
  observed?: RelayNodeSourceTuple | undefined;
  observedFingerprints?: string[] | undefined;
  strictDeny?: boolean | undefined;
  fingerprintKey?: string | undefined;
  now: string;
}): RelayNodeSourceEvaluation {
  const observed = normalizeRelayNodeSourceTuple(input.observed);
  const expected = normalizeRelayNodeSourceTuple(input.expected);
  const observedFingerprint = observed
    ? sourceFingerprint(observed, input.fingerprintKey)
    : undefined;
  if (!hasTailscaleSourceSignal(observed)) {
    const strictUnavailableDeny =
      Boolean(input.strictDeny) && hasTailscaleSourceSignal(expected);
    return {
      diagnostics: {
        state: strictUnavailableDeny ? 'strict-deny' : 'signal-unavailable',
        policy: input.strictDeny ? 'strict-deny' : 'audit',
        reasonCode: strictUnavailableDeny
          ? 'NODE_SOURCE_STRICT_DENY'
          : 'NODE_SOURCE_SIGNAL_UNAVAILABLE',
        observedAt: input.now,
        displayHint: sourceDisplayHint(undefined),
      },
      ...(observed ? { normalizedObserved: observed } : {}),
      ...(observedFingerprint ? { observedFingerprint } : {}),
      matchesExpected: false,
    };
  }

  const unique = new Set(input.observedFingerprints ?? []);
  if (observedFingerprint) unique.add(observedFingerprint);
  const matchesExpected = sourcesMatch(expected, observed);
  let state: RelayNodeSourceState = matchesExpected ? 'source-match' : 'source-mismatch';
  let reasonCode = matchesExpected ? 'NODE_SOURCE_MATCH' : 'NODE_SOURCE_MISMATCH';
  if (!matchesExpected && unique.size > 1) {
    state = 'same-credential-multiple-sources';
    reasonCode = 'NODE_SOURCE_MULTIPLE_SOURCES';
  }
  if (input.strictDeny && !matchesExpected) {
    state = 'strict-deny';
    reasonCode = 'NODE_SOURCE_STRICT_DENY';
  }
  return {
    diagnostics: {
      state,
      policy: input.strictDeny ? 'strict-deny' : 'audit',
      reasonCode,
      observedAt: input.now,
      ...(observedFingerprint ? { sourceFingerprint: observedFingerprint } : {}),
      displayHint: sourceDisplayHint(observed, observedFingerprint),
    },
    ...(observed ? { normalizedObserved: observed } : {}),
    ...(observedFingerprint ? { observedFingerprint } : {}),
    matchesExpected,
  };
}
