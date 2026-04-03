import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createTicketTransitionsRouter,
  type TicketTransitionsDeps,
} from '../server/ticket-transitions.js';
import type { TicketContext, BranchLink } from '../server/types.js';

// Loose mock type — cast to TicketTransitionsDeps['execAsync'] at call sites
type MockExec = (
  ...args: unknown[]
) => Promise<{ stdout: string; stderr: string }>;

interface ExecCall {
  cmd: string;
  args: string[];
  cwd: string | undefined;
}

// Shared temp config for all tests (checkPrTransitions calls loadConfig)
let sharedTmpDir: string;
let sharedConfigPath: string;

before(() => {
  sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  sharedConfigPath = path.join(sharedTmpDir, 'config.json');
  const minimalConfig = {
    host: '0.0.0.0',
    port: 3456,
    cookieTTL: '24h',
    repos: [],
    claudeCommand: 'claude',
    claudeArgs: [],
    defaultAgent: 'claude',
    defaultContinue: true,
    defaultYolo: false,
    launchInTmux: false,
    defaultNotifications: true,
  };
  fs.writeFileSync(sharedConfigPath, JSON.stringify(minimalConfig, null, 2));
});

after(() => {
  fs.rmSync(sharedTmpDir, { recursive: true, force: true });
});

function makeExecMock(opts: { shouldThrow?: boolean } = {}): {
  exec: MockExec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: MockExec = async (
    cmd: unknown,
    args: unknown,
    options: unknown
  ) => {
    const command = cmd as string;
    const argv = args as string[];
    const cwd = (options as { cwd?: string } | undefined)?.cwd;
    calls.push({ cmd: command, args: argv, cwd });
    if (opts.shouldThrow) {
      throw new Error('gh CLI error');
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function makeApp(execMock: MockExec) {
  const deps = {
    configPath: sharedConfigPath,
    execAsync: execMock,
  } as unknown as TicketTransitionsDeps;
  return createTicketTransitionsRouter(deps);
}

const REPO_PATH = '/fake/workspace/repo-a';

function makeTicketContext(
  overrides: Partial<TicketContext> = {}
): TicketContext {
  return {
    ticketId: 'GH-1',
    title: 'Test Issue',
    url: 'https://github.com/fake/repo/issues/1',
    source: 'github',
    repoPath: REPO_PATH,
    repoName: 'repo-a',
    ...overrides,
  };
}

function makeBranchLinks(
  ticketId: string,
  branchName: string
): Record<string, BranchLink[]> {
  return {
    [ticketId]: [
      {
        repoPath: REPO_PATH,
        repoName: 'repo-a',
        branchName,
        hasActiveSession: true,
      },
    ],
  };
}

describe('ticket-transitions', () => {
  describe('transitionOnSessionCreate', () => {
    test('adds in-progress label to GitHub issue', async () => {
      const { exec, calls } = makeExecMock();
      const { transitionOnSessionCreate } = makeApp(exec);

      const ctx = makeTicketContext({ ticketId: 'GH-100' });
      await transitionOnSessionCreate(ctx);

      const addLabelCall = calls.find(
        (c) =>
          c.cmd === 'gh' &&
          c.args.includes('--add-label') &&
          c.args.includes('in-progress')
      );
      assert.ok(
        addLabelCall,
        'Should have called gh issue edit --add-label in-progress'
      );
      assert.equal(addLabelCall.cwd, REPO_PATH);
      assert.ok(
        addLabelCall.args.includes('100'),
        'Should pass issue number 100'
      );
    });

    test('is idempotent — does not re-fire same transition', async () => {
      const { exec, calls } = makeExecMock();
      const { transitionOnSessionCreate } = makeApp(exec);

      const ctx = makeTicketContext({ ticketId: 'GH-101' });

      // First call — should fire
      await transitionOnSessionCreate(ctx);
      const firstCallCount = calls.length;
      assert.ok(firstCallCount > 0, 'First call should trigger gh');

      // Second call — should be a no-op (idempotent)
      await transitionOnSessionCreate(ctx);
      assert.equal(
        calls.length,
        firstCallCount,
        'Second call should not trigger additional gh calls'
      );
    });
  });

  describe('checkPrTransitions', () => {
    test('adds code-review label when PR is OPEN for a linked ticket', async () => {
      const { exec, calls } = makeExecMock();
      const { checkPrTransitions } = makeApp(exec);

      const ticketId = 'GH-200';
      const branchName = 'feat/my-feature';
      const prs = [
        { number: 1, headRefName: branchName, state: 'OPEN' as const },
      ];
      const branchLinks = makeBranchLinks(ticketId, branchName);

      await checkPrTransitions(prs, branchLinks);

      const addCodeReview = calls.find(
        (c) =>
          c.cmd === 'gh' &&
          c.args.includes('--add-label') &&
          c.args.includes('code-review')
      );
      assert.ok(
        addCodeReview,
        'Should have called gh issue edit --add-label code-review'
      );
      assert.equal(addCodeReview.cwd, REPO_PATH);
      assert.ok(
        addCodeReview.args.includes('200'),
        'Should pass issue number 200'
      );

      const removeInProgress = calls.find(
        (c) =>
          c.cmd === 'gh' &&
          c.args.includes('--remove-label') &&
          c.args.includes('in-progress')
      );
      assert.ok(removeInProgress, 'Should have removed in-progress label');
    });

    test('adds ready-for-qa label when PR is MERGED for a linked ticket', async () => {
      const { exec, calls } = makeExecMock();
      const { checkPrTransitions } = makeApp(exec);

      const ticketId = 'GH-300';
      const branchName = 'feat/merged-feature';
      const prs = [
        { number: 2, headRefName: branchName, state: 'MERGED' as const },
      ];
      const branchLinks = makeBranchLinks(ticketId, branchName);

      await checkPrTransitions(prs, branchLinks);

      const addReadyForQa = calls.find(
        (c) =>
          c.cmd === 'gh' &&
          c.args.includes('--add-label') &&
          c.args.includes('ready-for-qa')
      );
      assert.ok(
        addReadyForQa,
        'Should have called gh issue edit --add-label ready-for-qa'
      );
      assert.equal(addReadyForQa.cwd, REPO_PATH);
      assert.ok(
        addReadyForQa.args.includes('300'),
        'Should pass issue number 300'
      );

      const removeCodeReview = calls.find(
        (c) =>
          c.cmd === 'gh' &&
          c.args.includes('--remove-label') &&
          c.args.includes('code-review')
      );
      assert.ok(removeCodeReview, 'Should have removed code-review label');
    });

    test('is idempotent for PR transitions', async () => {
      const { exec, calls } = makeExecMock();
      const { checkPrTransitions } = makeApp(exec);

      const ticketId = 'GH-400';
      const branchName = 'feat/idempotent-pr';
      const prs = [
        { number: 3, headRefName: branchName, state: 'OPEN' as const },
      ];
      const branchLinks = makeBranchLinks(ticketId, branchName);

      // First call — should fire
      await checkPrTransitions(prs, branchLinks);
      const firstCallCount = calls.length;
      assert.ok(firstCallCount > 0, 'First call should trigger gh');

      // Second call with same PR state — should be a no-op (idempotent)
      await checkPrTransitions(prs, branchLinks);
      assert.equal(
        calls.length,
        firstCallCount,
        'Second call with same state should not trigger additional gh calls'
      );
    });

    test('handles gh CLI errors gracefully', async () => {
      const { exec } = makeExecMock({ shouldThrow: true });
      const { checkPrTransitions } = makeApp(exec);

      const ticketId = 'GH-500';
      const branchName = 'feat/error-branch';
      const prs = [
        { number: 4, headRefName: branchName, state: 'OPEN' as const },
      ];
      const branchLinks = makeBranchLinks(ticketId, branchName);

      // Should not throw even when gh CLI fails
      await assert.doesNotReject(
        () => checkPrTransitions(prs, branchLinks),
        'checkPrTransitions should not throw when gh CLI errors'
      );
    });
  });
});

// ─── Jira transition tests ────────────────────────────────────────────────────

describe('ticket-transitions (Jira)', () => {
  let tmpDir: string;
  let configPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-jira-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJiraConfig(statusMappings: Record<string, string>) {
    const config = {
      host: '0.0.0.0',
      port: 3456,
      cookieTTL: '24h',
      repos: [],
      claudeCommand: 'claude',
      claudeArgs: [],
      defaultAgent: 'claude',
      defaultContinue: true,
      defaultYolo: false,
      launchInTmux: false,
      defaultNotifications: true,
      integrations: {
        jira: { projectKey: 'PROJ', statusMappings },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  function makeJiraApp(execOverride?: MockExec) {
    const { exec } = makeExecMock();
    const effectiveExec = execOverride ?? exec;
    const deps = {
      configPath,
      execAsync: effectiveExec,
    } as unknown as TicketTransitionsDeps;
    return createTicketTransitionsRouter(deps);
  }

  test('transitionOnSessionCreate calls acli jira workitem transition for Jira ticket', async () => {
    writeJiraConfig({ 'in-progress': 'In Progress' });

    const acliCalls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: MockExec = async (cmd: unknown, args: unknown) => {
      acliCalls.push({ cmd: cmd as string, args: args as string[] });
      return { stdout: '', stderr: '' };
    };

    const { transitionOnSessionCreate } = makeJiraApp(trackingExec);

    const ctx: TicketContext = {
      ticketId: 'PROJ-123',
      title: 'Test',
      url: 'https://jira.example.com/browse/PROJ-123',
      source: 'jira',
      repoPath: '/fake/repo',
      repoName: 'repo',
    };
    await transitionOnSessionCreate(ctx);

    const transitionCall = acliCalls.find(
      (c) =>
        c.cmd === 'acli' &&
        c.args.includes('transition') &&
        c.args.includes('PROJ-123')
    );
    assert.ok(
      transitionCall,
      `Expected acli jira workitem transition call, got: ${JSON.stringify(acliCalls)}`
    );
    assert.ok(
      transitionCall.args.includes('In Progress'),
      'Should pass the mapped status name'
    );
  });

  test('transitionOnSessionCreate skips when no status mapping configured', async () => {
    writeJiraConfig({}); // Empty mappings — no 'in-progress' key

    const acliCalls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: MockExec = async (cmd: unknown, args: unknown) => {
      acliCalls.push({ cmd: cmd as string, args: args as string[] });
      return { stdout: '', stderr: '' };
    };

    const { transitionOnSessionCreate } = makeJiraApp(trackingExec);

    const ctx: TicketContext = {
      ticketId: 'PROJ-456',
      title: 'Test',
      url: 'https://jira.example.com/browse/PROJ-456',
      source: 'jira',
      repoPath: '/fake/repo',
      repoName: 'repo',
    };
    await transitionOnSessionCreate(ctx);

    assert.equal(
      acliCalls.length,
      0,
      'Should not call acli when no status mapping exists'
    );
  });

  test('transitionOnSessionCreate is idempotent — second call blocked after success', async () => {
    writeJiraConfig({ 'in-progress': 'In Progress' });

    const acliCalls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: MockExec = async (cmd: unknown, args: unknown) => {
      acliCalls.push({ cmd: cmd as string, args: args as string[] });
      return { stdout: '', stderr: '' };
    };

    const { transitionOnSessionCreate } = makeJiraApp(trackingExec);

    const ctx: TicketContext = {
      ticketId: 'PROJ-55',
      title: 'Jira test issue',
      url: 'https://jira.example.com/browse/PROJ-55',
      source: 'jira',
      repoPath: '/fake/repo',
      repoName: 'repo',
    };

    await transitionOnSessionCreate(ctx);
    const firstCallCount = acliCalls.length;
    assert.ok(firstCallCount > 0, 'First call should trigger acli');

    // Second call — should be blocked by idempotency guard
    await transitionOnSessionCreate(ctx);
    assert.equal(
      acliCalls.length,
      firstCallCount,
      'Second call should be blocked by idempotency guard after success'
    );
  });

  test('checkPrTransitions calls acli jira workitem transition for OPEN PR with mapped Jira ticket', async () => {
    writeJiraConfig({
      'code-review': 'Code Review',
      'ready-for-qa': 'Ready for QA',
    });

    const acliCalls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: MockExec = async (cmd: unknown, args: unknown) => {
      acliCalls.push({ cmd: cmd as string, args: args as string[] });
      return { stdout: '', stderr: '' };
    };

    const { checkPrTransitions } = makeJiraApp(trackingExec);

    const prs = [
      { number: 10, headRefName: 'feat/jira-pr', state: 'OPEN' as const },
    ];
    const branchLinks: Record<string, BranchLink[]> = {
      'PROJ-789': [
        {
          repoPath: '/fake/repo',
          repoName: 'repo',
          branchName: 'feat/jira-pr',
          hasActiveSession: true,
        },
      ],
    };

    await checkPrTransitions(prs, branchLinks);

    const transitionCall = acliCalls.find(
      (c) =>
        c.cmd === 'acli' &&
        c.args.includes('transition') &&
        c.args.includes('PROJ-789')
    );
    assert.ok(
      transitionCall,
      `Expected acli jira workitem transition call, got: ${JSON.stringify(acliCalls)}`
    );
    assert.ok(
      transitionCall.args.includes('Code Review'),
      'Should use code-review status name'
    );
  });
});
