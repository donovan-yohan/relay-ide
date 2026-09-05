import fs from 'node:fs';
import path from 'node:path';

import {
  parseChannelDeliveryExpectation,
  type ChannelDeliveryExpectation,
} from '../shared/channel-delivery-contract.js';
import { safeRegexTest } from './safe-regex.js';

export type DeliveryContractProbeOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unknown'; reason: string };

export interface DeliveryContractGitProbe {
  /** Symbolic branch name (no refs/ prefix), or null if detached/unborn. */
  currentBranch(): Promise<DeliveryContractProbeOutcome<string | null>>;
  /** Ahead count of HEAD vs an upstream/base reference (>=0). */
  aheadCount(): Promise<DeliveryContractProbeOutcome<number>>;
}

export interface DeliveryContractPrProbe {
  /** True when an open PR exists for this head branch. */
  hasOpenPrForBranch(
    branch: string
  ): Promise<DeliveryContractProbeOutcome<boolean>>;
}

export interface DeliveryContractFsProbe {
  /** Check existence of a path relative to the routing cwd. */
  exists(relPath: string): Promise<DeliveryContractProbeOutcome<boolean>>;
}

export interface EvaluateDeliveryContractInput {
  expect: readonly string[];
  /** Routing cwd for file existence and default git context. */
  cwd: string;
  /** Final assistant message text for this run/turn. */
  finalAssistantText: string;
}

export interface DeliveryContractResult {
  met: boolean;
  unmet: string[];
  unknown: Array<{ spec: string; reason: string }>;
}

const MAX_TEXT_BYTES = 64 * 1024;
const TEXT_REGEX_TIMEOUT_MS = 200;

export async function evaluateDeliveryContract(
  input: EvaluateDeliveryContractInput,
  probes: {
    git: DeliveryContractGitProbe;
    pr: DeliveryContractPrProbe;
    fs?: DeliveryContractFsProbe;
  }
): Promise<DeliveryContractResult> {
  const unmet: string[] = [];
  const unknown: Array<{ spec: string; reason: string }> = [];
  const fsProbe: DeliveryContractFsProbe =
    probes.fs ??
    ({
      exists: async (rel) => {
        try {
          const cwd = path.resolve(input.cwd);
          const target = path.resolve(cwd, rel);
          const prefix = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`;
          if (target !== cwd && !target.startsWith(prefix)) {
            return {
              kind: 'unknown',
              reason: 'file expectation escapes routing cwd',
            };
          }
          return { kind: 'ok', value: fs.existsSync(target) };
        } catch (err) {
          return {
            kind: 'unknown',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      },
    } satisfies DeliveryContractFsProbe);

  for (const raw of input.expect) {
    const spec = raw.trim();
    if (!spec) continue;
    let parsed: ChannelDeliveryExpectation;
    try {
      parsed = parseChannelDeliveryExpectation(spec);
    } catch {
      // Parsing is enforced at the gateway boundary; a malformed stored spec is
      // treated as unmet rather than crashing evaluation.
      unmet.push(spec);
      continue;
    }
    const outcome = await evaluateOne(parsed);
    if (outcome.kind === 'ok') {
      if (!outcome.value) unmet.push(spec);
    } else {
      unknown.push({ spec, reason: outcome.reason });
    }
  }
  return { met: unmet.length === 0 && unknown.length === 0, unmet, unknown };

  async function evaluateOne(
    expectation: ChannelDeliveryExpectation
  ): Promise<DeliveryContractProbeOutcome<boolean>> {
    switch (expectation.kind) {
      case 'commit': {
        const ahead = await probes.git.aheadCount();
        if (ahead.kind === 'unknown') return ahead;
        const n = ahead.value;
        return { kind: 'ok', value: Number.isFinite(n) && n >= 1 };
      }
      case 'file': {
        return fsProbe.exists(expectation.path);
      }
      case 'text': {
        const haystack = input.finalAssistantText.slice(0, MAX_TEXT_BYTES);
        const result = await safeRegexTest(expectation.regex, haystack, {
          timeoutMs: TEXT_REGEX_TIMEOUT_MS,
        });
        if (result.kind === 'unknown') return result;
        return { kind: 'ok', value: result.matched };
      }
      case 'pr': {
        const branch = expectation.branch;
        if (branch && branch.trim()) {
          return probes.pr.hasOpenPrForBranch(branch.trim());
        }
        const current = await probes.git.currentBranch();
        if (current.kind === 'unknown') return current;
        const resolved = current.value ?? '';
        if (!resolved.trim()) {
          return {
            kind: 'unknown',
            reason: 'unable to resolve current branch',
          };
        }
        return probes.pr.hasOpenPrForBranch(resolved.trim());
      }
      default: {
        const _exhaustive: never = expectation;
        void _exhaustive;
        // Unknown kind: unmet.
        return { kind: 'ok', value: false };
      }
    }
  }
}
