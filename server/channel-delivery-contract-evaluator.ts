import fs from 'node:fs';
import path from 'node:path';

import {
  parseChannelDeliveryExpectation,
  type ChannelDeliveryExpectation,
} from '../shared/channel-delivery-contract.js';

export interface DeliveryContractGitProbe {
  /** Symbolic branch name (no refs/ prefix), or null if detached/unborn. */
  currentBranch(): Promise<string | null>;
  /** Ahead count of HEAD vs an upstream/base reference (>=0). */
  aheadCount(): Promise<number>;
}

export interface DeliveryContractPrProbe {
  /** True when an open PR exists for this head branch. */
  hasOpenPrForBranch(branch: string): Promise<boolean>;
}

export interface DeliveryContractFsProbe {
  /** Check existence of a path relative to the routing cwd. */
  exists(relPath: string): Promise<boolean>;
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
}

export async function evaluateDeliveryContract(
  input: EvaluateDeliveryContractInput,
  probes: {
    git: DeliveryContractGitProbe;
    pr: DeliveryContractPrProbe;
    fs?: DeliveryContractFsProbe;
  }
): Promise<DeliveryContractResult> {
  const unmet: string[] = [];
  const fsProbe: DeliveryContractFsProbe =
    probes.fs ??
    ({
      exists: async (rel) => fs.existsSync(path.join(input.cwd, rel)),
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
    const ok = await evaluateOne(parsed);
    if (!ok) unmet.push(spec);
  }
  return { met: unmet.length === 0, unmet };

  async function evaluateOne(
    expectation: ChannelDeliveryExpectation
  ): Promise<boolean> {
    switch (expectation.kind) {
      case 'commit': {
        const ahead = await probes.git.aheadCount();
        return Number.isFinite(ahead) && ahead >= 1;
      }
      case 'file': {
        return fsProbe.exists(expectation.path);
      }
      case 'text': {
        try {
          const re = new RegExp(expectation.regex);
          return re.test(input.finalAssistantText);
        } catch {
          // Should not happen (validated at parse), but fail closed.
          return false;
        }
      }
      case 'pr': {
        const branch =
          expectation.branch ?? (await probes.git.currentBranch()) ?? '';
        if (!branch.trim()) return false;
        return probes.pr.hasOpenPrForBranch(branch.trim());
      }
      default: {
        const _exhaustive: never = expectation;
        void _exhaustive;
        // Unknown kind: unmet.
        return false;
      }
    }
  }
}
