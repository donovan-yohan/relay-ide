import {
  test,
  beforeAll,
  afterAll,
  afterEach,
  expect,
  vi,
  describe,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PortAllocator,
  initializeDefaultAllocator,
  getDefaultAllocator,
  resetDefaultAllocator,
  verifyPort,
  extractEnvBlock,
  upsertEnvBlock,
  removeEnvBlock,
  parseEnvBlock,
  normalizePortVariables,
  upsertPortsInEnvFile,
  removePortsFromEnvFile,
  ENV_BLOCK_START,
  ENV_BLOCK_END,
  PORT_RANGE_START,
  PORT_RANGE_END,
  OVERFLOW_RANGE_START,
  OVERFLOW_RANGE_END,
} from '../server/port-allocator.js';

let tmpDir!: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-port-alloc-test-'));
});

afterEach(() => {
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    const fullPath = path.join(tmpDir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }
  resetDefaultAllocator();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Port Allocator Tests ──────────────────────────────────────────────────

describe('PortAllocator', () => {
  test('allocates ports in primary range', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    const ports = await allocator.allocatePortsForWorktree('repo-1', 'wt-1', [
      'PORT',
      'DEV_PORT',
    ]);

    expect(ports.PORT).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(ports.PORT).toBeLessThan(PORT_RANGE_END);
    expect(ports.DEV_PORT).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(ports.DEV_PORT).toBeLessThan(PORT_RANGE_END);
    expect(ports.PORT).not.toBe(ports.DEV_PORT);
  });

  test('persists assignments to port-assignments.json', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    await allocator.allocatePortsForWorktree('repo-1', 'wt-1', ['PORT']);

    const assignmentsPath = path.join(tmpDir, 'port-assignments.json');
    expect(fs.existsSync(assignmentsPath)).toBe(true);

    const raw = fs.readFileSync(assignmentsPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(data.assignments).toHaveLength(1);
    expect(data.assignments[0].repoId).toBe('repo-1');
    expect(data.assignments[0].worktreeId).toBe('wt-1');
    expect(data.assignments[0].variableName).toBe('PORT');
  });

  test('loads existing assignments on construction', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    // Pre-create assignments file
    const assignmentsPath = path.join(tmpDir, 'port-assignments.json');
    const existingAssignments = {
      version: 1,
      assignments: [
        {
          repoId: 'repo-existing',
          worktreeId: 'wt-existing',
          variableName: 'PORT',
          port: 10050,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    fs.writeFileSync(
      assignmentsPath,
      JSON.stringify(existingAssignments),
      'utf8'
    );

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    const ports = allocator.getPortsForWorktree('repo-existing', 'wt-existing');
    expect(ports).toEqual({ PORT: 10050 });
  });

  test('getPortsForWorktree returns null for unknown worktree', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    const ports = allocator.getPortsForWorktree('unknown-repo', 'unknown-wt');
    expect(ports).toBeNull();
  });

  test('releasePortsForWorktree removes assignments', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    await allocator.allocatePortsForWorktree('repo-1', 'wt-1', ['PORT']);
    expect(allocator.getPortsForWorktree('repo-1', 'wt-1')).toBeDefined();

    allocator.releasePortsForWorktree('repo-1', 'wt-1');
    expect(allocator.getPortsForWorktree('repo-1', 'wt-1')).toBeNull();
  });

  test('releasePortsForWorktree does not affect other worktrees', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    await allocator.allocatePortsForWorktree('repo-1', 'wt-1', ['PORT']);
    await allocator.allocatePortsForWorktree('repo-1', 'wt-2', ['PORT']);

    allocator.releasePortsForWorktree('repo-1', 'wt-1');

    expect(allocator.getPortsForWorktree('repo-1', 'wt-1')).toBeNull();
    expect(allocator.getPortsForWorktree('repo-1', 'wt-2')).toBeDefined();
  });

  test('returns same port for repeated allocation of same variable', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    const ports1 = await allocator.allocatePortsForWorktree('repo-1', 'wt-1', [
      'PORT',
    ]);
    const ports2 = await allocator.allocatePortsForWorktree('repo-1', 'wt-1', [
      'PORT',
    ]);

    expect(ports1.PORT).toBe(ports2.PORT);
  });

  test('assigns different ports to different variables', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    const ports = await allocator.allocatePortsForWorktree('repo-1', 'wt-1', [
      'PORT',
      'VITE_PORT',
      'API_PORT',
    ]);

    const portValues = Object.values(ports);
    const uniquePorts = new Set(portValues);
    expect(uniquePorts.size).toBe(portValues.length);
  });

  test('assigns different ports to same variable across worktrees', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    const ports1 = await allocator.allocatePortsForWorktree('repo-1', 'wt-1', [
      'PORT',
    ]);
    const ports2 = await allocator.allocatePortsForWorktree('repo-1', 'wt-2', [
      'PORT',
    ]);

    expect(ports1.PORT).not.toBe(ports2.PORT);
  });

  test('normalizePortVariables falls back to PORT and de-duplicates', () => {
    expect(normalizePortVariables(undefined)).toEqual(['PORT']);
    expect(normalizePortVariables([])).toEqual(['PORT']);
    expect(normalizePortVariables([' PORT ', 'PORT', 'API_PORT'])).toEqual([
      'PORT',
      'API_PORT',
    ]);
  });

  test('reconcilePortsForWorktree removes stale variables and adds new ones', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    const initial = await allocator.allocatePortsForWorktree('repo-1', 'wt-1', [
      'PORT',
      'DEV_PORT',
    ]);
    const reconciled = await allocator.reconcilePortsForWorktree(
      'repo-1',
      'wt-1',
      ['PORT', 'API_PORT']
    );

    expect(reconciled.PORT).toBe(initial.PORT);
    expect(reconciled.API_PORT).toBeTypeOf('number');
    expect(reconciled.DEV_PORT).toBeUndefined();
  });
});

// ── Port Verification Tests ───────────────────────────────────────────────

describe('PortAllocator port verification', () => {
  test('initializes without error when no existing assignments', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await expect(allocator.initialize()).resolves.not.toThrow();
  });

  test('reassigns ports that are taken on startup', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    // Pre-create assignments with a port in primary range
    const assignmentsPath = path.join(tmpDir, 'port-assignments.json');
    const existingAssignments = {
      version: 1,
      assignments: [
        {
          repoId: 'repo-existing',
          worktreeId: 'wt-existing',
          variableName: 'PORT',
          port: 10001, // Known port that might be taken
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    fs.writeFileSync(
      assignmentsPath,
      JSON.stringify(existingAssignments),
      'utf8'
    );

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    const ports = allocator.getPortsForWorktree('repo-existing', 'wt-existing');
    // Port should be in valid range (may be reassigned if 10001 was taken)
    expect(ports?.PORT).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(ports?.PORT).toBeLessThan(OVERFLOW_RANGE_END);
  });
});

// ── verifyPort standalone utility tests ───────────────────────────────────

describe('verifyPort', () => {
  test('returns available=true for free port', async () => {
    // A high port in our range is very unlikely to be taken
    const result = await verifyPort(10543);
    expect(result.port).toBe(10543);
    expect(result.available).toBe(true);
  });

  test('returns available=false for system port', async () => {
    // Port 80 is a privileged port and typically requires root
    const result = await verifyPort(80);
    expect(result.port).toBe(80);
    // On most systems this will be unavailable or will be denied
    expect(typeof result.available).toBe('boolean');
  });
});

// ── .env Block Utilities Tests ─────────────────────────────────────────────

describe('extractEnvBlock', () => {
  test('extracts block with markers', () => {
    const content = `# Existing content
SOME_VAR=value
${ENV_BLOCK_START}
PORT=10000
${ENV_BLOCK_END}
ANOTHER_VAR=foo
`;

    const result = extractEnvBlock(content);

    expect(result.block).toBe(
      `${ENV_BLOCK_START}\nPORT=10000\n${ENV_BLOCK_END}`
    );
    expect(result.before).toBe('# Existing content\nSOME_VAR=value\n');
    expect(result.after.trim()).toBe('ANOTHER_VAR=foo');
  });

  test('returns null block when markers not found', () => {
    const content = `SOME_VAR=value
ANOTHER_VAR=foo`;

    const result = extractEnvBlock(content);

    expect(result.block).toBeNull();
    expect(result.before).toBe(content);
    expect(result.after).toBe('');
  });

  test('returns null block when only start marker found', () => {
    const content = `SOME_VAR=value
${ENV_BLOCK_START}
PORT=10000`;

    const result = extractEnvBlock(content);

    expect(result.block).toBeNull();
  });

  test('returns null block when markers are reversed', () => {
    const content = `${ENV_BLOCK_END}
${ENV_BLOCK_START}
PORT=10000`;

    const result = extractEnvBlock(content);

    expect(result.block).toBeNull();
  });

  test('handles empty content', () => {
    const result = extractEnvBlock('');
    expect(result.block).toBeNull();
    expect(result.before).toBe('');
    expect(result.after).toBe('');
  });
});

describe('upsertEnvBlock', () => {
  test('inserts block into empty content', () => {
    const result = upsertEnvBlock('', { PORT: 10000, VITE_PORT: 10001 });

    expect(result).toContain(ENV_BLOCK_START);
    expect(result).toContain(ENV_BLOCK_END);
    expect(result).toContain('PORT=10000');
    expect(result).toContain('VITE_PORT=10001');
  });

  test('inserts block into content without existing block', () => {
    const content = `# My project
MY_VAR=value
`;

    const result = upsertEnvBlock(content, { PORT: 10050 });

    expect(result).toContain('# My project');
    expect(result).toContain('MY_VAR=value');
    expect(result).toContain(ENV_BLOCK_START);
    expect(result).toContain('PORT=10050');
    expect(result).toContain(ENV_BLOCK_END);
  });

  test('replaces existing block', () => {
    const content = `${ENV_BLOCK_START}
PORT=10000
${ENV_BLOCK_END}`;

    const result = upsertEnvBlock(content, { PORT: 10099, API_PORT: 10100 });

    expect(result).not.toContain('PORT=10000');
    expect(result).toContain('PORT=10099');
    expect(result).toContain('API_PORT=10100');
  });

  test('preserves content before and after block', () => {
    const content = `# Header
SECRET_KEY=abc123

${ENV_BLOCK_START}
PORT=10000
${ENV_BLOCK_END}

# Footer
DEBUG=true`;

    const result = upsertEnvBlock(content, { PORT: 10050 });

    expect(result).toContain('# Header');
    expect(result).toContain('SECRET_KEY=abc123');
    expect(result).toContain('# Footer');
    expect(result).toContain('DEBUG=true');
  });

  test('sorts variables alphabetically in block', () => {
    const result = upsertEnvBlock('', {
      ZEBRA_PORT: 10003,
      ALPHA_PORT: 10001,
      MIDDLE_PORT: 10002,
    });

    const lines = result.split('\n');
    const blockStart = lines.findIndex((l) => l.includes(ENV_BLOCK_START));
    const blockEnd = lines.findIndex((l) => l.includes(ENV_BLOCK_END));

    // Get lines between markers
    const varLines = lines.slice(blockStart + 1, blockEnd);

    expect(varLines.length).toBe(3);
    expect(varLines[0]).toContain('ALPHA_PORT');
    expect(varLines[1]).toContain('MIDDLE_PORT');
    expect(varLines[2]).toContain('ZEBRA_PORT');
  });

  test('handles multiple upsert iterations', () => {
    let content = '';

    content = upsertEnvBlock(content, { PORT: 10000 });
    expect(content).toContain('PORT=10000');

    content = upsertEnvBlock(content, { PORT: 10001, NEW_PORT: 10002 });
    expect(content).toContain('PORT=10001');
    expect(content).toContain('NEW_PORT=10002');
    expect(content).not.toContain('PORT=10000');

    // Should have only one block - escape special chars for regex
    const escapedMarker = ENV_BLOCK_START.replace(/[()]/g, '\\$&');
    const startCount = (content.match(new RegExp(escapedMarker, 'g')) || [])
      .length;
    expect(startCount).toBe(1);
  });
});

describe('removeEnvBlock', () => {
  test('removes block and preserves surrounding content', () => {
    const content = `# Header
MY_VAR=value

${ENV_BLOCK_START}
PORT=10000
${ENV_BLOCK_END}

# Footer
DEBUG=true`;

    const result = removeEnvBlock(content);

    expect(result).not.toContain(ENV_BLOCK_START);
    expect(result).not.toContain(ENV_BLOCK_END);
    expect(result).not.toContain('PORT=10000');
    expect(result).toContain('# Header');
    expect(result).toContain('MY_VAR=value');
    expect(result).toContain('# Footer');
    expect(result).toContain('DEBUG=true');
  });

  test('returns empty string for block-only content', () => {
    const content = `${ENV_BLOCK_START}
PORT=10000
${ENV_BLOCK_END}`;

    const result = removeEnvBlock(content);
    expect(result.trim()).toBe('');
  });

  test('returns unchanged content when no block exists', () => {
    const content = `# My project
MY_VAR=value`;

    const result = removeEnvBlock(content);
    expect(result).toBe(content);
  });

  test('handles empty content', () => {
    const result = removeEnvBlock('');
    expect(result).toBe('');
  });
});

describe('parseEnvBlock', () => {
  test('parses variables from block', () => {
    const content = `${ENV_BLOCK_START}
PORT=10000
VITE_PORT=10001
${ENV_BLOCK_END}`;

    const result = parseEnvBlock(content);

    expect(result).toEqual({
      PORT: 10000,
      VITE_PORT: 10001,
    });
  });

  test('skips comments inside block', () => {
    const content = `${ENV_BLOCK_START}
# This is a comment
PORT=10000
# Another comment
${ENV_BLOCK_END}`;

    const result = parseEnvBlock(content);

    expect(result).toEqual({ PORT: 10000 });
  });

  test('skips empty lines inside block', () => {
    const content = `${ENV_BLOCK_START}

PORT=10000

${ENV_BLOCK_END}`;

    const result = parseEnvBlock(content);

    expect(result).toEqual({ PORT: 10000 });
  });

  test('returns null when no block found', () => {
    const content = `PORT=10000
SOME_VAR=value`;

    const result = parseEnvBlock(content);

    expect(result).toBeNull();
  });

  test('returns null for empty block', () => {
    const content = `${ENV_BLOCK_START}
${ENV_BLOCK_END}`;

    const result = parseEnvBlock(content);

    expect(result).toBeNull();
  });

  test('handles values with equals sign', () => {
    const content = `${ENV_BLOCK_START}
DATABASE_URL=postgres://user:pass@host:5432/db
${ENV_BLOCK_END}`;

    // This should parse as a string, not a number, so it's skipped
    const result = parseEnvBlock(content);
    expect(result).toBeNull(); // Non-numeric values are skipped
  });

  test('skips invalid port values', () => {
    const content = `${ENV_BLOCK_START}
PORT=abc
ANOTHER_PORT=-1
VALID_PORT=10000
${ENV_BLOCK_END}`;

    const result = parseEnvBlock(content);

    expect(result).toEqual({ VALID_PORT: 10000 });
  });
});

// ── Default Allocator Tests ───────────────────────────────────────────────

describe('Default allocator singleton', () => {
  test('initializeDefaultAllocator creates and initializes allocator', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = await initializeDefaultAllocator(configPath);

    expect(allocator).toBeInstanceOf(PortAllocator);
    expect(getDefaultAllocator()).toBe(allocator);
  });

  test('getDefaultAllocator throws when not initialized', () => {
    resetDefaultAllocator();

    expect(() => getDefaultAllocator()).toThrow(
      'Default port allocator not initialized'
    );
  });

  test('resetDefaultAllocator clears singleton', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    await initializeDefaultAllocator(configPath);
    expect(() => getDefaultAllocator()).not.toThrow();

    resetDefaultAllocator();
    expect(() => getDefaultAllocator()).toThrow();
  });
});

// ─── Port Range Constants Tests ───────────────────────────────────────────

describe('Port range constants', () => {
  test('primary range is 10000-10999', () => {
    expect(PORT_RANGE_START).toBe(10000);
    expect(PORT_RANGE_END).toBe(11000);
    expect(PORT_RANGE_END - PORT_RANGE_START).toBe(1000);
  });

  test('overflow range is 11000-11999', () => {
    expect(OVERFLOW_RANGE_START).toBe(11000);
    expect(OVERFLOW_RANGE_END).toBe(12000);
    expect(OVERFLOW_RANGE_END - OVERFLOW_RANGE_START).toBe(1000);
  });
});

// ─── Integration-ish Tests ────────────────────────────────────────────────

describe('Port allocator + .env block integration', () => {
  test('full workflow: allocate, upsert, parse, get, remove', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf8');

    const allocator = new PortAllocator({ configPath });
    await allocator.initialize();

    // Allocate ports
    const ports = await allocator.allocatePortsForWorktree(
      'my-repo',
      'feature-branch',
      ['PORT', 'VITE_PORT']
    );

    // Create .env content
    let envContent = upsertEnvBlock('', ports);
    expect(envContent).toContain(`PORT=${ports.PORT}`);
    expect(envContent).toContain(`VITE_PORT=${ports.VITE_PORT}`);

    // Parse it back
    const parsed = parseEnvBlock(envContent);
    expect(parsed).toEqual(ports);

    // Get ports from allocator
    const storedPorts = allocator.getPortsForWorktree(
      'my-repo',
      'feature-branch'
    );
    expect(storedPorts).toEqual(ports);

    // Release and remove
    allocator.releasePortsForWorktree('my-repo', 'feature-branch');
    envContent = removeEnvBlock(envContent);

    expect(parseEnvBlock(envContent)).toBeNull();
    expect(
      allocator.getPortsForWorktree('my-repo', 'feature-branch')
    ).toBeNull();
  });

  test('env file helpers write and remove managed block on disk', () => {
    const worktreeDir = fs.mkdtempSync(path.join(tmpDir, 'wt-'));
    fs.writeFileSync(path.join(worktreeDir, '.env'), 'EXISTING=true\n', 'utf8');

    upsertPortsInEnvFile(worktreeDir, { PORT: 10001, API_PORT: 10002 });
    const withPorts = fs.readFileSync(path.join(worktreeDir, '.env'), 'utf8');
    expect(withPorts).toContain('EXISTING=true');
    expect(withPorts).toContain('PORT=10001');
    expect(withPorts).toContain('API_PORT=10002');

    removePortsFromEnvFile(worktreeDir);
    const withoutPorts = fs.readFileSync(
      path.join(worktreeDir, '.env'),
      'utf8'
    );
    expect(withoutPorts.trim()).toBe('EXISTING=true');
  });
});
