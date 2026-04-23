import { test, expect } from 'vitest';
import {
  BUILTIN_FRAMEWORKS,
  AGENT_COMMANDS,
  AGENT_CONTINUE_ARGS,
  AGENT_YOLO_ARGS,
  resolveFramework,
} from '../server/types.js';
import type { AgentFramework, EventSourceType } from '../server/types.js';

// ── BUILTIN_FRAMEWORKS structure ──

test('BUILTIN_FRAMEWORKS contains claude, codex, and opencode', () => {
  expect('claude' in BUILTIN_FRAMEWORKS).toBeTruthy();
  expect('codex' in BUILTIN_FRAMEWORKS).toBeTruthy();
  expect('opencode' in BUILTIN_FRAMEWORKS).toBeTruthy();
});

test('claude framework has correct values', () => {
  const claude = BUILTIN_FRAMEWORKS['claude'];
  expect(claude.id).toBe('claude');
  expect(claude.displayName).toBe('Claude Code');
  expect(claude.command).toBe('claude');
  expect(claude.continueArgs).toEqual(['--continue']);
  expect(claude.yoloArgs).toEqual(['--dangerously-skip-permissions']);
  expect(claude.parserType).toBe('claude');
  expect(claude.eventSource).toBe('hooks');
  expect(claude.capabilities.supportsHooks).toBe(true);
  expect(claude.capabilities.supportsContinue).toBe(true);
  expect(claude.capabilities.supportsYolo).toBe(true);
  expect(claude.capabilities.supportsTelemetry).toBe(true);
});

test('codex framework has correct values', () => {
  const codex = BUILTIN_FRAMEWORKS['codex'];
  expect(codex.id).toBe('codex');
  expect(codex.displayName).toBe('Codex');
  expect(codex.command).toBe('codex');
  expect(codex.continueArgs).toEqual(['resume', '--last']);
  expect(codex.yoloArgs).toEqual([
    '--ask-for-approval',
    'never',
    '--sandbox',
    'workspace-write',
  ]);
  expect(codex.parserType).toBe('codex');
  expect(codex.eventSource).toBe('hooks');
  expect(codex.capabilities.supportsHooks).toBe(true);
  expect(codex.capabilities.supportsContinue).toBe(true);
  expect(codex.capabilities.supportsYolo).toBe(true);
  expect(codex.capabilities.supportsTelemetry).toBe(false);
});

test('opencode framework has correct values', () => {
  const opencode = BUILTIN_FRAMEWORKS['opencode'];
  expect(opencode.id).toBe('opencode');
  expect(opencode.displayName).toBe('OpenCode');
  expect(opencode.command).toBe('opencode');
  expect(opencode.continueArgs).toEqual(['--continue']);
  expect(opencode.yoloArgs).toEqual([]);
  expect(opencode.parserType).toBe('opencode');
  expect(opencode.eventSource).toBe('plugin');
  expect(opencode.capabilities.supportsHooks).toBe(false);
  expect(opencode.capabilities.supportsContinue).toBe(true);
  expect(opencode.capabilities.supportsYolo).toBe(true);
  expect(opencode.capabilities.supportsTelemetry).toBe(true);
});

test('opencode yoloEnv contains OPENCODE_CONFIG_CONTENT with permission JSON', () => {
  const opencode = BUILTIN_FRAMEWORKS['opencode'];
  expect(opencode.yoloEnv).toBeTruthy();
  expect('OPENCODE_CONFIG_CONTENT' in opencode.yoloEnv!).toBeTruthy();
  const parsed = JSON.parse(opencode.yoloEnv!['OPENCODE_CONFIG_CONTENT']);
  expect(parsed.permission).toBeTruthy();
  expect(parsed.permission.read).toBe('allow');
  expect(parsed.permission.edit).toBe('allow');
  expect(parsed.permission.bash).toBe('allow');
});

// ── resolveFramework ──

test('resolveFramework returns builtin framework unmodified when no config override', () => {
  const result = resolveFramework({}, 'claude');
  expect(result).toEqual(BUILTIN_FRAMEWORKS['claude']);
});

test('resolveFramework returns builtin codex when no config override', () => {
  const result = resolveFramework({}, 'codex');
  expect(result).toEqual(BUILTIN_FRAMEWORKS['codex']);
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
  expect(result.commandOverride).toBe('/usr/local/bin/claude');
  expect(result.displayName).toBe('My Claude');
  // non-overridden fields remain unchanged
  expect(result.command).toBe('claude');
  expect(result.continueArgs).toEqual(['--continue']);
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
  expect(result.capabilities.supportsHooks).toBe(false);
  // other capabilities should remain from builtin
  expect(result.capabilities.supportsContinue).toBe(true);
  expect(result.capabilities.supportsYolo).toBe(true);
  expect(result.capabilities.supportsTelemetry).toBe(true);
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
      supportsAttachedRuntime: false,
    },
  };
  const result = resolveFramework(
    { frameworks: { myagent: customFramework } },
    'myagent'
  );
  expect(result.id).toBe('myagent');
  expect(result.displayName).toBe('My Agent');
  expect(result.command).toBe('myagent');
});

test('resolveFramework throws for unknown framework not in config', () => {
  expect(() => resolveFramework({}, 'nonexistent')).toThrow(
    /unknown.*framework|framework.*unknown|nonexistent/i
  );
});

test('resolveFramework throws for unknown framework not in config.frameworks', () => {
  expect(() =>
    resolveFramework({ frameworks: { other: { id: 'other' } } }, 'nonexistent')
  ).toThrow(/unknown.*framework|framework.*unknown|nonexistent/i);
});

test('resolveFramework throws for custom framework missing required fields', () => {
  expect(() =>
    resolveFramework({ frameworks: { bad: { id: 'bad' } } }, 'bad')
  ).toThrow(
    /must define.*command|must define.*continueArgs|must define.*capabilities/i
  );
});

// ── Backward-compat aliases ──

test('AGENT_COMMANDS is derived from BUILTIN_FRAMEWORKS', () => {
  expect(AGENT_COMMANDS['claude']).toBe(BUILTIN_FRAMEWORKS['claude'].command);
  expect(AGENT_COMMANDS['codex']).toBe(BUILTIN_FRAMEWORKS['codex'].command);
  expect(AGENT_COMMANDS['opencode']).toBe(
    BUILTIN_FRAMEWORKS['opencode'].command
  );
});

test('AGENT_CONTINUE_ARGS is derived from BUILTIN_FRAMEWORKS', () => {
  expect(AGENT_CONTINUE_ARGS['claude']).toEqual(
    BUILTIN_FRAMEWORKS['claude'].continueArgs
  );
  expect(AGENT_CONTINUE_ARGS['codex']).toEqual(
    BUILTIN_FRAMEWORKS['codex'].continueArgs
  );
  expect(AGENT_CONTINUE_ARGS['opencode']).toEqual(
    BUILTIN_FRAMEWORKS['opencode'].continueArgs
  );
});

test('AGENT_YOLO_ARGS is derived from BUILTIN_FRAMEWORKS', () => {
  expect(AGENT_YOLO_ARGS['claude']).toEqual(
    BUILTIN_FRAMEWORKS['claude'].yoloArgs
  );
  expect(AGENT_YOLO_ARGS['codex']).toEqual(
    BUILTIN_FRAMEWORKS['codex'].yoloArgs
  );
  expect(AGENT_YOLO_ARGS['opencode']).toEqual(
    BUILTIN_FRAMEWORKS['opencode'].yoloArgs
  );
});

test('AGENT_COMMANDS still has claude and codex for backward compat', () => {
  expect(AGENT_COMMANDS['claude']).toBe('claude');
  expect(AGENT_COMMANDS['codex']).toBe('codex');
});

test('AGENT_CONTINUE_ARGS still has claude and codex for backward compat', () => {
  expect(AGENT_CONTINUE_ARGS['claude']).toEqual(['--continue']);
  expect(AGENT_CONTINUE_ARGS['codex']).toEqual(['resume', '--last']);
});

test('AGENT_YOLO_ARGS still has claude and codex for backward compat', () => {
  expect(AGENT_YOLO_ARGS['claude']).toEqual(['--dangerously-skip-permissions']);
  expect(AGENT_YOLO_ARGS['codex']).toEqual([
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
    expect(validSources).toContain(fw.eventSource);
  }
});
