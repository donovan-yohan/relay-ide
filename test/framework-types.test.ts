import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_FRAMEWORKS,
  AGENT_COMMANDS,
  AGENT_CONTINUE_ARGS,
  AGENT_YOLO_ARGS,
  resolveFramework,
} from '../server/types.js';
import type {
  AgentFramework,
  BuiltinFrameworkId,
  EventSourceType,
} from '../server/types.js';

// ── BUILTIN_FRAMEWORKS structure ──

test('BUILTIN_FRAMEWORKS contains claude, codex, and opencode', () => {
  assert.ok('claude' in BUILTIN_FRAMEWORKS);
  assert.ok('codex' in BUILTIN_FRAMEWORKS);
  assert.ok('opencode' in BUILTIN_FRAMEWORKS);
});

test('claude framework has correct values', () => {
  const claude = BUILTIN_FRAMEWORKS['claude'];
  assert.equal(claude.id, 'claude');
  assert.equal(claude.displayName, 'Claude Code');
  assert.equal(claude.command, 'claude');
  assert.deepEqual(claude.continueArgs, ['--continue']);
  assert.deepEqual(claude.yoloArgs, ['--dangerously-skip-permissions']);
  assert.equal(claude.parserType, 'claude');
  assert.equal(claude.eventSource, 'hooks');
  assert.equal(claude.capabilities.supportsHooks, true);
  assert.equal(claude.capabilities.supportsContinue, true);
  assert.equal(claude.capabilities.supportsYolo, true);
  assert.equal(claude.capabilities.supportsTelemetry, true);
});

test('codex framework has correct values', () => {
  const codex = BUILTIN_FRAMEWORKS['codex'];
  assert.equal(codex.id, 'codex');
  assert.equal(codex.displayName, 'Codex');
  assert.equal(codex.command, 'codex');
  assert.deepEqual(codex.continueArgs, ['resume', '--last']);
  assert.deepEqual(codex.yoloArgs, [
    '--ask-for-approval',
    'never',
    '--sandbox',
    'workspace-write',
  ]);
  assert.equal(codex.parserType, 'codex');
  assert.equal(codex.eventSource, 'hooks');
  assert.equal(codex.capabilities.supportsHooks, true);
  assert.equal(codex.capabilities.supportsContinue, true);
  assert.equal(codex.capabilities.supportsYolo, true);
  assert.equal(codex.capabilities.supportsTelemetry, false);
});

test('opencode framework has correct values', () => {
  const opencode = BUILTIN_FRAMEWORKS['opencode'];
  assert.equal(opencode.id, 'opencode');
  assert.equal(opencode.displayName, 'OpenCode');
  assert.equal(opencode.command, 'opencode');
  assert.deepEqual(opencode.continueArgs, ['--continue']);
  assert.deepEqual(opencode.yoloArgs, []);
  assert.equal(opencode.parserType, 'opencode');
  assert.equal(opencode.eventSource, 'plugin');
  assert.equal(opencode.capabilities.supportsHooks, false);
  assert.equal(opencode.capabilities.supportsContinue, true);
  assert.equal(opencode.capabilities.supportsYolo, true);
  assert.equal(opencode.capabilities.supportsTelemetry, true);
});

test('opencode yoloEnv contains OPENCODE_CONFIG_CONTENT with permission JSON', () => {
  const opencode = BUILTIN_FRAMEWORKS['opencode'];
  assert.ok(opencode.yoloEnv, 'yoloEnv should be defined');
  assert.ok('OPENCODE_CONFIG_CONTENT' in opencode.yoloEnv!);
  const parsed = JSON.parse(opencode.yoloEnv!['OPENCODE_CONFIG_CONTENT']);
  assert.ok(parsed.permission, 'permission key should exist');
  assert.equal(parsed.permission.read, 'allow');
  assert.equal(parsed.permission.edit, 'allow');
  assert.equal(parsed.permission.bash, 'allow');
});

// ── resolveFramework ──

test('resolveFramework returns builtin framework unmodified when no config override', () => {
  const result = resolveFramework({}, 'claude');
  assert.deepEqual(result, BUILTIN_FRAMEWORKS['claude']);
});

test('resolveFramework returns builtin codex when no config override', () => {
  const result = resolveFramework({}, 'codex');
  assert.deepEqual(result, BUILTIN_FRAMEWORKS['codex']);
});

test('resolveFramework applies top-level overrides from config.frameworks', () => {
  const result = resolveFramework(
    {
      frameworks: {
        claude: {
          commandOverride: '/usr/local/bin/claude',
          displayName: 'My Claude',
        },
      },
    },
    'claude'
  );
  assert.equal(result.commandOverride, '/usr/local/bin/claude');
  assert.equal(result.displayName, 'My Claude');
  // non-overridden fields remain unchanged
  assert.equal(result.command, 'claude');
  assert.deepEqual(result.continueArgs, ['--continue']);
});

test('resolveFramework deep merges capabilities from config.frameworks', () => {
  const result = resolveFramework(
    {
      frameworks: {
        claude: {
          capabilities: {
            supportsHooks: false,
          } as AgentFramework['capabilities'],
        },
      },
    },
    'claude'
  );
  assert.equal(result.capabilities.supportsHooks, false);
  // other capabilities should remain from builtin
  assert.equal(result.capabilities.supportsContinue, true);
  assert.equal(result.capabilities.supportsYolo, true);
  assert.equal(result.capabilities.supportsTelemetry, true);
});

test('resolveFramework supports fully custom framework from config.frameworks', () => {
  const customFramework: Partial<AgentFramework> = {
    id: 'myagent',
    displayName: 'My Agent',
    command: 'myagent',
    continueArgs: ['--resume'],
    yoloArgs: [],
    parserType: 'myagent',
    eventSource: 'parser' as EventSourceType,
    capabilities: {
      supportsHooks: false,
      supportsContinue: true,
      supportsYolo: false,
      supportsTelemetry: false,
    },
  };
  const result = resolveFramework(
    { frameworks: { myagent: customFramework } },
    'myagent'
  );
  assert.equal(result.id, 'myagent');
  assert.equal(result.displayName, 'My Agent');
  assert.equal(result.command, 'myagent');
});

test('resolveFramework throws for unknown framework not in config', () => {
  assert.throws(
    () => resolveFramework({}, 'nonexistent'),
    /unknown.*framework|framework.*unknown|nonexistent/i
  );
});

test('resolveFramework throws for unknown framework not in config.frameworks', () => {
  assert.throws(
    () =>
      resolveFramework(
        { frameworks: { other: { id: 'other' } } },
        'nonexistent'
      ),
    /unknown.*framework|framework.*unknown|nonexistent/i
  );
});

test('resolveFramework throws for custom framework missing required fields', () => {
  assert.throws(
    () => resolveFramework({ frameworks: { bad: { id: 'bad' } } }, 'bad'),
    /must define.*command|must define.*continueArgs|must define.*capabilities/i
  );
});

// ── Backward-compat aliases ──

test('AGENT_COMMANDS is derived from BUILTIN_FRAMEWORKS', () => {
  assert.equal(AGENT_COMMANDS['claude'], BUILTIN_FRAMEWORKS['claude'].command);
  assert.equal(AGENT_COMMANDS['codex'], BUILTIN_FRAMEWORKS['codex'].command);
  assert.equal(
    AGENT_COMMANDS['opencode'],
    BUILTIN_FRAMEWORKS['opencode'].command
  );
});

test('AGENT_CONTINUE_ARGS is derived from BUILTIN_FRAMEWORKS', () => {
  assert.deepEqual(
    AGENT_CONTINUE_ARGS['claude'],
    BUILTIN_FRAMEWORKS['claude'].continueArgs
  );
  assert.deepEqual(
    AGENT_CONTINUE_ARGS['codex'],
    BUILTIN_FRAMEWORKS['codex'].continueArgs
  );
  assert.deepEqual(
    AGENT_CONTINUE_ARGS['opencode'],
    BUILTIN_FRAMEWORKS['opencode'].continueArgs
  );
});

test('AGENT_YOLO_ARGS is derived from BUILTIN_FRAMEWORKS', () => {
  assert.deepEqual(
    AGENT_YOLO_ARGS['claude'],
    BUILTIN_FRAMEWORKS['claude'].yoloArgs
  );
  assert.deepEqual(
    AGENT_YOLO_ARGS['codex'],
    BUILTIN_FRAMEWORKS['codex'].yoloArgs
  );
  assert.deepEqual(
    AGENT_YOLO_ARGS['opencode'],
    BUILTIN_FRAMEWORKS['opencode'].yoloArgs
  );
});

test('AGENT_COMMANDS still has claude and codex for backward compat', () => {
  assert.equal(AGENT_COMMANDS['claude'], 'claude');
  assert.equal(AGENT_COMMANDS['codex'], 'codex');
});

test('AGENT_CONTINUE_ARGS still has claude and codex for backward compat', () => {
  assert.deepEqual(AGENT_CONTINUE_ARGS['claude'], ['--continue']);
  assert.deepEqual(AGENT_CONTINUE_ARGS['codex'], ['resume', '--last']);
});

test('AGENT_YOLO_ARGS still has claude and codex for backward compat', () => {
  assert.deepEqual(AGENT_YOLO_ARGS['claude'], [
    '--dangerously-skip-permissions',
  ]);
  assert.deepEqual(AGENT_YOLO_ARGS['codex'], [
    '--ask-for-approval',
    'never',
    '--sandbox',
    'workspace-write',
  ]);
});

// ── EventSourceType type check ──

test('EventSourceType values are used correctly in BUILTIN_FRAMEWORKS', () => {
  const validSources: EventSourceType[] = [
    'hooks',
    'plugin',
    'parser',
    'timer',
  ];
  for (const fw of Object.values(BUILTIN_FRAMEWORKS)) {
    assert.ok(
      validSources.includes(fw.eventSource),
      `${fw.id} eventSource should be valid`
    );
  }
});
