/**
 * Fake `agy` child process double for the Antigravity conformance fixture.
 */
import {
  makeHarness,
  type ClaudeChildHarness,
} from '../../support/claude-child-double.js';

export const ANTIGRAVITY_SESSION = 'antigravity-conf-1';
export const ANTIGRAVITY_BASE_PID = 5252;

export function makeAntigravityChildHarness(): ClaudeChildHarness {
  return makeHarness({ basePid: ANTIGRAVITY_BASE_PID });
}
