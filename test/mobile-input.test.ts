import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIntent } from '../server/mobile-input-pipeline.js';
import type { CapturedIntent } from '../server/mobile-input-pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures', 'mobile-input');

interface EventStep {
  inputType: string;
  data: string | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  valueBefore: string;
  cursorBefore: number;
  valueAfter: string;
}

interface EventFixture {
  name: string;
  description: string;
  device: string;
  events: EventStep[];
  expectedPayload: string;
}

function loadFixture(filename: string): EventFixture {
  const raw = readFileSync(join(FIXTURES_DIR, filename), 'utf-8');
  return JSON.parse(raw) as EventFixture;
}

function replayFixture(fixture: EventFixture): string {
  let totalPayload = '';
  for (const step of fixture.events) {
    const intent: CapturedIntent = {
      type: step.inputType,
      data: step.data,
      rangeStart: step.rangeStart,
      rangeEnd: step.rangeEnd,
      valueBefore: step.valueBefore,
      cursorBefore: step.cursorBefore,
    };
    const result = processIntent(intent, step.valueAfter);
    totalPayload += result.payload;
  }
  return totalPayload;
}

function assertReplacementNotLost(
  payload: string,
  expectedReplacement: string,
  fixtureName: string
) {
  expect(
    payload.includes(expectedReplacement),
    `[${fixtureName}] Payload contains only backspaces — replacement text "${expectedReplacement}" was lost. Got: ${JSON.stringify(payload)}`
  ).toBeTruthy();
}

// ── Fixture replay tests ─────────────────────────────────────────────

describe('mobile-input-pipeline: fixture replay', () => {
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) =>
    f.endsWith('.json')
  );

  for (const file of fixtureFiles) {
    const fixture = loadFixture(file);
    it(`${fixture.name}: ${fixture.description}`, () => {
      const actualPayload = replayFixture(fixture);
      expect(actualPayload).toBe(fixture.expectedPayload);
    });
  }
});

// ── Autocorrect invariant tests ──────────────────────────────────────

describe('mobile-input-pipeline: autocorrect always includes replacement text', () => {
  it('Gboard range replacement includes replacement text', () => {
    const fixture = loadFixture('gboard-autocorrect-range.json');
    const payload = replayFixture(fixture);
    assertReplacementNotLost(payload, 'the', fixture.name);
  });

  it('Gboard cursor-0 recovery includes replacement text', () => {
    const fixture = loadFixture('gboard-autocorrect-cursor0.json');
    const payload = replayFixture(fixture);
    assertReplacementNotLost(payload, 'the', fixture.name);
  });

  it('iOS insertReplacementText includes replacement text', () => {
    const fixture = loadFixture('ios-replacement-text.json');
    const payload = replayFixture(fixture);
    assertReplacementNotLost(payload, 'the', fixture.name);
  });

  it('multi-word buffer: only target word deleted, replacement inserted', () => {
    const fixture = loadFixture('gboard-autocorrect-multi-word.json');
    const payload = replayFixture(fixture);
    assertReplacementNotLost(payload, 'the', fixture.name);
    const backspaceCount = (payload.match(/\x7f/g) ?? []).length;
    expect(backspaceCount).toBe(3);
  });
});

// ── processIntent unit tests ─────────────────────────────────────────

describe('mobile-input-pipeline: processIntent', () => {
  it('normal character insertion sends data directly', () => {
    const result = processIntent(
      {
        type: 'insertText',
        data: 'a',
        rangeStart: 5,
        rangeEnd: 5,
        valueBefore: 'hello',
        cursorBefore: 5,
      },
      'helloa'
    );
    expect(result.payload).toBe('a');
    expect(result.newInputValue).toBe(undefined);
  });

  it('autocorrect with range sends backspaces + replacement', () => {
    const result = processIntent(
      {
        type: 'insertText',
        data: 'the',
        rangeStart: 0,
        rangeEnd: 3,
        valueBefore: 'teh',
        cursorBefore: 3,
      },
      'the'
    );
    expect(result.payload).toBe('\x7f\x7f\x7fthe');
  });

  it('cursor-0 recovery: single word buffer', () => {
    const result = processIntent(
      {
        type: 'insertText',
        data: 'the',
        rangeStart: null,
        rangeEnd: null,
        valueBefore: 'teh',
        cursorBefore: 0,
      },
      'theteh'
    );
    expect(result.payload).toBe('\x7f\x7f\x7fthe');
    expect(result.newInputValue).toBe('the');
  });

  it('cursor-0 recovery: multi-word buffer only deletes last word', () => {
    const result = processIntent(
      {
        type: 'insertText',
        data: 'mobile ',
        rangeStart: null,
        rangeEnd: null,
        valueBefore: 'and mkbijf',
        cursorBefore: 0,
      },
      'mobile and mkbijf'
    );
    expect(result.payload).toBe('\x7f\x7f\x7f\x7f\x7f\x7fmobile ');
    expect(result.newInputValue).toBe('and mobile ');
  });

  it('cursor-0 recovery: suffix-only data (data[0] !== firstChar)', () => {
    // Gboard sends suffix "esting " instead of full word "testing "
    // because firstChar "t" was kept and data starts with "e"
    const result = processIntent(
      {
        type: 'insertText',
        data: 'esting ',
        rangeStart: null,
        rangeEnd: null,
        valueBefore: 'tsestin',
        cursorBefore: 0,
      },
      'esting tsestin'
    );
    // data[0]='e' !== firstChar='t' → suffix mode: "t" + "esting " = "testing "
    expect(result.payload).toBe('\x7f\x7f\x7f\x7f\x7f\x7f\x7ftesting ');
    expect(result.newInputValue).toBe('testing ');
  });

  it('cursor-0 recovery: trailing space means nothing to autocorrect', () => {
    const result = processIntent(
      {
        type: 'insertText',
        data: 'the ',
        rangeStart: null,
        rangeEnd: null,
        valueBefore: 'hello ',
        cursorBefore: 0,
      },
      'the hello '
    );
    expect(result.payload).toBe('');
    expect(result.newInputValue).toBe('hello ');
  });

  it('deleteContentBackward with range', () => {
    const result = processIntent(
      {
        type: 'deleteContentBackward',
        data: null,
        rangeStart: 4,
        rangeEnd: 5,
        valueBefore: 'hello',
        cursorBefore: 5,
      },
      'hell'
    );
    expect(result.payload).toBe('\x7f');
  });

  it('deleteWordBackward with range sends correct backspace count', () => {
    const result = processIntent(
      {
        type: 'deleteWordBackward',
        data: null,
        rangeStart: 6,
        rangeEnd: 11,
        valueBefore: 'hello world',
        cursorBefore: 11,
      },
      'hello '
    );
    expect(result.payload).toBe('\x7f\x7f\x7f\x7f\x7f');
  });

  it('deleteContentBackward without range falls back to diff', () => {
    const result = processIntent(
      {
        type: 'deleteContentBackward',
        data: null,
        rangeStart: null,
        rangeEnd: null,
        valueBefore: 'hello',
        cursorBefore: 5,
      },
      'hell'
    );
    expect(result.payload).toBe('\x7f');
  });

  it('insertReplacementText sends backspaces + replacement', () => {
    const result = processIntent(
      {
        type: 'insertReplacementText',
        data: 'the',
        rangeStart: 0,
        rangeEnd: 3,
        valueBefore: 'teh',
        cursorBefore: 3,
      },
      'the'
    );
    expect(result.payload).toBe('\x7f\x7f\x7fthe');
  });

  it('insertFromPaste uses diff to extract pasted text', () => {
    const result = processIntent(
      {
        type: 'insertFromPaste',
        data: null,
        rangeStart: null,
        rangeEnd: null,
        valueBefore: 'hello',
        cursorBefore: 5,
      },
      'hello world'
    );
    expect(result.payload).toBe(' world');
  });

  it('unknown inputType falls back to diff', () => {
    const result = processIntent(
      {
        type: 'insertFromYank',
        data: null,
        rangeStart: null,
        rangeEnd: null,
        valueBefore: 'hllo',
        cursorBefore: 1,
      },
      'hello'
    );
    expect(result.payload).toBe('\x7f\x7f\x7fello');
  });

  it('empty payload for no-op diff', () => {
    const result = processIntent(
      {
        type: 'insertText',
        data: null,
        rangeStart: null,
        rangeEnd: null,
        valueBefore: 'hello',
        cursorBefore: 5,
      },
      'hello'
    );
    expect(result.payload).toBe('');
  });

  it('handles emoji codepoints correctly in autocorrect range', () => {
    const result = processIntent(
      {
        type: 'insertText',
        data: 'smile',
        rangeStart: 0,
        rangeEnd: 2,
        valueBefore: '😊',
        cursorBefore: 2,
      },
      'smile'
    );
    expect(result.payload).toBe('\x7fsmile');
  });
});
