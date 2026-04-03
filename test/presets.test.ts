import { test, describe, beforeAll, afterAll, afterEach, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  DEFAULT_PRESETS,
  DEFAULTS,
  loadConfig,
  saveConfig,
} from '../server/config.js';
import type { FilterPreset } from '../server/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeConfigPath(): string {
  return path.join(tmpDir, 'config.json');
}

/**
 * Applies the same validation logic used in POST /presets (server/index.ts).
 * Returns an error string or null if valid.
 */
function validatePreset(body: {
  name?: unknown;
  sort?: unknown;
}): string | null {
  const { name, sort } = body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return 'name is required';
  }
  if (sort && typeof sort === 'object') {
    const dir = (sort as Record<string, unknown>).direction;
    if (dir !== 'asc' && dir !== 'desc') {
      return 'sort.direction must be "asc" or "desc"';
    }
  }
  return null;
}

/**
 * Applies the same deletion guard used in DELETE /presets/:name (server/index.ts).
 * Returns an error string or null if deletion is allowed.
 */
function validateDeletion(
  presets: FilterPreset[],
  name: string
): string | null {
  const target = presets.find((p) => p.name === name);
  if (!target) {
    return 'Preset not found';
  }
  if (target.builtIn) {
    return 'Cannot delete a built-in preset';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-test-'));
});

afterEach(() => {
  for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
    const fullPath = path.join(tmpDir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }
});

afterAll(() => {
  fs.rmdirSync(tmpDir);
});

// ---------------------------------------------------------------------------
// Tests — DEFAULT_PRESETS
// ---------------------------------------------------------------------------

describe('DEFAULT_PRESETS', () => {
  test('contains at least two built-in presets', () => {
    expect(DEFAULT_PRESETS.length >= 2).toBeTruthy();
  });

  test('all default presets are marked builtIn', () => {
    for (const preset of DEFAULT_PRESETS) {
      expect(preset.builtIn).toBe(true);
    }
  });

  test('all default presets have valid sort direction', () => {
    for (const preset of DEFAULT_PRESETS) {
      expect(
        preset.sort.direction === 'asc' || preset.sort.direction === 'desc'
      ).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — loadConfig sets default presets when absent
// ---------------------------------------------------------------------------

describe('loadConfig preset initialisation', () => {
  test('injects DEFAULT_PRESETS when filterPresets is absent from config file', () => {
    const configPath = makeConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({ port: 3456 }), 'utf8');
    const config = loadConfig(configPath);
    expect(config.filterPresets).toEqual(DEFAULT_PRESETS);
  });

  test('preserves user-supplied filterPresets from config file', () => {
    const configPath = makeConfigPath();
    const userPresets: FilterPreset[] = [
      {
        name: 'My Preset',
        filters: {},
        sort: { column: 'age', direction: 'asc' },
      },
    ];
    fs.writeFileSync(
      configPath,
      JSON.stringify({ port: 3456, filterPresets: userPresets }),
      'utf8'
    );
    const config = loadConfig(configPath);
    expect(config.filterPresets).toEqual(userPresets);
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /presets validation logic
// ---------------------------------------------------------------------------

describe('preset creation validation', () => {
  test('rejects missing name', () => {
    expect(validatePreset({ sort: { direction: 'asc' } })).toBe(
      'name is required'
    );
  });

  test('rejects empty string name', () => {
    expect(validatePreset({ name: '' })).toBe('name is required');
  });

  test('rejects whitespace-only name', () => {
    expect(validatePreset({ name: '   ' })).toBe('name is required');
  });

  test('rejects invalid sort.direction', () => {
    expect(
      validatePreset({ name: 'Valid Name', sort: { direction: 'invalid' } })
    ).toBe('sort.direction must be "asc" or "desc"');
  });

  test('accepts valid name with asc direction', () => {
    expect(
      validatePreset({ name: 'My Preset', sort: { direction: 'asc' } })
    ).toBe(null);
  });

  test('accepts valid name with desc direction', () => {
    expect(
      validatePreset({ name: 'My Preset', sort: { direction: 'desc' } })
    ).toBe(null);
  });

  test('accepts valid name with no sort (sort is optional)', () => {
    expect(validatePreset({ name: 'My Preset' })).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Tests — preset storage (push + saveConfig round-trip)
// ---------------------------------------------------------------------------

describe('preset storage', () => {
  test('new preset is persisted via saveConfig and reloaded by loadConfig', () => {
    const configPath = makeConfigPath();
    saveConfig(configPath, {
      ...DEFAULTS,
      filterPresets: [...DEFAULT_PRESETS],
    });

    const config = loadConfig(configPath);
    const newPreset: FilterPreset = {
      name: 'Team Review',
      filters: { role: ['reviewer'] },
      sort: { column: 'age', direction: 'desc' },
    };
    config.filterPresets!.push(newPreset);
    saveConfig(configPath, config);

    const reloaded = loadConfig(configPath);
    const found = reloaded.filterPresets?.find((p) => p.name === 'Team Review');
    expect(found).toBeTruthy();
    expect(found).toEqual(newPreset);
  });

  test('duplicate name can be pushed (endpoint does not deduplicate — caller responsibility)', () => {
    // The server endpoint does not currently check for duplicate names,
    // so both entries will be stored. This test documents that behaviour.
    const configPath = makeConfigPath();
    saveConfig(configPath, {
      ...DEFAULTS,
      filterPresets: [...DEFAULT_PRESETS],
    });

    const config = loadConfig(configPath);
    const preset: FilterPreset = {
      name: 'Dupe',
      filters: {},
      sort: { column: 'role', direction: 'asc' },
    };
    config.filterPresets!.push(preset);
    config.filterPresets!.push(preset);
    saveConfig(configPath, config);

    const reloaded = loadConfig(configPath);
    const matches =
      reloaded.filterPresets?.filter((p) => p.name === 'Dupe') ?? [];
    expect(matches.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /presets validation logic
// ---------------------------------------------------------------------------

describe('preset deletion validation', () => {
  test('rejects deletion of a built-in preset', () => {
    const presets: FilterPreset[] = [
      {
        name: 'All PRs',
        builtIn: true,
        filters: {},
        sort: { column: 'age', direction: 'desc' },
      },
    ];
    expect(validateDeletion(presets, 'All PRs')).toBe(
      'Cannot delete a built-in preset'
    );
  });

  test('rejects deletion of a preset that does not exist', () => {
    const presets: FilterPreset[] = [
      {
        name: 'All PRs',
        builtIn: true,
        filters: {},
        sort: { column: 'age', direction: 'desc' },
      },
    ];
    expect(validateDeletion(presets, 'Nonexistent')).toBe('Preset not found');
  });

  test('allows deletion of a user-created preset', () => {
    const presets: FilterPreset[] = [
      {
        name: 'All PRs',
        builtIn: true,
        filters: {},
        sort: { column: 'age', direction: 'desc' },
      },
      {
        name: 'My Custom',
        filters: {},
        sort: { column: 'role', direction: 'asc' },
      },
    ];
    expect(validateDeletion(presets, 'My Custom')).toBe(null);
  });

  test('deletion removes exactly the named preset and leaves others intact', () => {
    const configPath = makeConfigPath();
    const initialPresets: FilterPreset[] = [
      ...DEFAULT_PRESETS,
      {
        name: 'To Delete',
        filters: {},
        sort: { column: 'role', direction: 'asc' },
      },
    ];
    saveConfig(configPath, { ...DEFAULTS, filterPresets: initialPresets });

    const config = loadConfig(configPath);
    config.filterPresets = config.filterPresets!.filter(
      (p) => p.name !== 'To Delete'
    );
    saveConfig(configPath, config);

    const reloaded = loadConfig(configPath);
    const remaining = reloaded.filterPresets ?? [];
    expect(remaining.find((p) => p.name === 'To Delete')).toBe(undefined);
    // Built-in presets survive
    for (const dp of DEFAULT_PRESETS) {
      expect(remaining.find((p) => p.name === dp.name)).toBeTruthy();
    }
  });
});
