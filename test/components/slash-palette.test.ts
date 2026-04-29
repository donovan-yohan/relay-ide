import { describe, expect, it } from 'vitest';
import { useSlashCommands } from '../../frontend/src/components/chat/SlashPalette.js';

describe('slash palette command derivation', () => {
  it('deduplicates SDK commands by slash name and preserves argument hints', () => {
    const text = '/';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      text.length,
      [
        {
          name: 'review',
          description: 'Pre-landing PR review.',
          argumentHint: '<scope>',
        },
        {
          name: '/review',
          description: 'Duplicate review command from another source.',
          argumentHint: '',
        },
        {
          name: 'plan-design-review',
          description: "Designer's eye plan review.",
          argumentHint: '',
        },
      ]
    );

    expect(commands).toEqual([
      {
        command: '/review',
        description: 'Pre-landing PR review.',
        shortcut: '',
        argumentHint: '<scope>',
      },
      {
        command: '/plan-design-review',
        description: "Designer's eye plan review.",
        shortcut: '',
      },
    ]);
  });

  it('matches command aliases without rendering duplicate alias rows', () => {
    const text = '/rev';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      text.length,
      [
        {
          name: 'review',
          description: 'Pre-landing PR review.',
          argumentHint: '',
          aliases: ['rev'],
        },
      ]
    );

    expect(commands.map((command) => command.command)).toEqual(['/review']);
  });

  it('searches Relay-owned alternate command names and selects the canonical command', () => {
    const text = '/continue';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      text.length,
      [
        {
          name: 'resume',
          description: 'resume a saved session',
          argumentHint: '',
          aliases: ['continue'],
          source: 'relay',
          dispatch: 'relay-control',
        },
      ]
    );

    expect(commands).toEqual([
      {
        command: '/resume',
        description: 'resume a saved session',
        shortcut: '',
        source: 'relay',
      },
    ]);
  });

  it('searches fallback aliases before the SDK command catalog is loaded', () => {
    const text = '/new';
    const commands = useSlashCommands({ slashCommands: true, resume: true }, text, text.length);

    expect(commands.map((command) => command.command)).toEqual(['/clear']);
  });
});

describe('slash palette — trigger via $ prefix', () => {
  it('$skill triggers palette for dollar-prefix query', () => {
    const text = '$re';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      text.length,
      [
        { name: 'review', description: 'Pre-landing PR review.' },
        { name: 'resume', description: 'resume session' },
      ]
    );
    expect(commands.map((c) => c.command)).toContain('/review');
    expect(commands.map((c) => c.command)).toContain('/resume');
  });

  it('mid-text $skill trigger activates palette', () => {
    const text = 'hey $rev';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      text.length,
      [{ name: 'review', description: 'review' }]
    );
    expect(commands.map((c) => c.command)).toContain('/review');
  });
});

describe('slash palette — caret position sensitivity', () => {
  it('/skill arg — caret after skill name shows palette', () => {
    // "/clear arg" caret at 6 (right after "clear") — trigger still active
    const text = '/clear arg';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      6 // caret after "/clear"
    );
    // should return fallback clear command (or any with "clear" match)
    expect(commands.length).toBeGreaterThan(0);
  });

  it('/skill arg — caret after space closes palette', () => {
    // "/clear arg" caret at 7 (after space) — whitespace in span → no trigger
    const text = '/clear arg';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      7 // caret is in "arg", walking back hits space before trigger
    );
    // palette should be closed
    expect(commands).toEqual([]);
  });
});

describe('slash palette — two-pass scoring', () => {
  const catalog = [
    { name: 'review', description: 'review code changes' },
    { name: 'preview', description: 'preview the PR' },
    { name: 'compare', description: 'compare review branches' },
  ];

  it('tier 1 (startsWith) appears before tier 2 (includes)', () => {
    const text = '/rev';
    const commands = useSlashCommands({ slashCommands: true }, text, text.length, catalog);
    const names = commands.map((c) => c.command);
    // 'review' startsWith 'rev' → tier 1
    // 'preview' includes 'rev' but doesn't start with it → tier 2
    const reviewIdx = names.indexOf('/review');
    const previewIdx = names.indexOf('/preview');
    expect(reviewIdx).toBeGreaterThanOrEqual(0);
    expect(previewIdx).toBeGreaterThanOrEqual(0);
    expect(reviewIdx).toBeLessThan(previewIdx);
  });

  it('description-only match appears below name match', () => {
    // 'rev' matches 'review' by name (tier 1) and 'compare review branches' by description (tier 3)
    const text = '/rev';
    const commands = useSlashCommands({ slashCommands: true }, text, text.length, catalog);
    const names = commands.map((c) => c.command);
    const reviewIdx = names.indexOf('/review');
    const compareIdx = names.indexOf('/compare');
    expect(reviewIdx).toBeGreaterThanOrEqual(0);
    expect(compareIdx).toBeGreaterThanOrEqual(0);
    expect(reviewIdx).toBeLessThan(compareIdx);
  });

  it('match span payload is included for matched entries', () => {
    const text = '/rev';
    const commands = useSlashCommands({ slashCommands: true }, text, text.length, catalog);
    const reviewCmd = commands.find((c) => c.command === '/review');
    expect(reviewCmd?.matchSpans).toBeDefined();
    expect(reviewCmd?.matchSpans).toEqual([[0, 3]]); // 'rev' at position 0-3 in 'review'
  });

  it('empty query shows full catalog with no match spans', () => {
    const text = '/';
    const commands = useSlashCommands({ slashCommands: true }, text, text.length, catalog);
    expect(commands.length).toBe(3);
    expect(commands.every((c) => c.matchSpans === undefined)).toBe(true);
  });
});

describe('slash palette — newline-before-trigger leading semantics', () => {
  it('trigger after newline is detected (leading)', () => {
    const text = 'intro\n/skill';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      text.length,
      [{ name: 'skill', description: 'a skill' }]
    );
    expect(commands.map((c) => c.command)).toContain('/skill');
  });

  it('non-leading (space before) trigger also works', () => {
    const text = 'hello /skill';
    const commands = useSlashCommands(
      { slashCommands: true },
      text,
      text.length,
      [{ name: 'skill', description: 'a skill' }]
    );
    expect(commands.map((c) => c.command)).toContain('/skill');
  });
});
