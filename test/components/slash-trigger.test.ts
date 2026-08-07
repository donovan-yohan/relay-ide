import { describe, expect, it } from 'vitest';
import { detectSlashTrigger } from '../../frontend/src/components/chat/slashTrigger.js';

describe('detectSlashTrigger — §4.2 edge ledger', () => {
  it('/cle at caret 4 — leading trigger', () => {
    const result = detectSlashTrigger('/cle', 4);
    expect(result).toEqual({ prefix: '/', query: 'cle', span: [0, 4], isLeading: true });
  });

  it('\\n/cle at caret 5 — newline-before is leading', () => {
    const result = detectSlashTrigger('\n/cle', 5);
    expect(result).toEqual({ prefix: '/', query: 'cle', span: [1, 5], isLeading: true });
  });

  it('hey /cle at caret 8 — space-before is not leading', () => {
    const result = detectSlashTrigger('hey /cle', 8);
    expect(result).toEqual({ prefix: '/', query: 'cle', span: [4, 8], isLeading: false });
  });

  it('hey $sk at caret 7 — dollar trigger mid-text', () => {
    const result = detectSlashTrigger('hey $sk', 7);
    expect(result).toEqual({ prefix: '$', query: 'sk', span: [4, 7], isLeading: false });
  });

  it('example$skill at caret 13 — non-whitespace precedes → null', () => {
    const result = detectSlashTrigger('example$skill', 13);
    expect(result).toBeNull();
  });

  it('this/that at caret 9 — non-whitespace precedes slash → null', () => {
    const result = detectSlashTrigger('this/that', 9);
    expect(result).toBeNull();
  });

  it('/clear arg at caret 10 — whitespace in span closes trigger → null', () => {
    // caret is past the space: "/clear arg" caret=10 means we're in 'arg'
    // walk back: 'g','r','a' → hit ' ' before finding trigger → null
    const result = detectSlashTrigger('/clear arg', 10);
    expect(result).toBeNull();
  });

  it('/clear at caret 6 — active trigger with no trailing space', () => {
    const result = detectSlashTrigger('/clear', 6);
    expect(result).toEqual({ prefix: '/', query: 'clear', span: [0, 6], isLeading: true });
  });

  it('after space, re-type /x — new mid-text trigger', () => {
    // "/clear /x" with caret at 9 (end)
    const result = detectSlashTrigger('/clear /x', 9);
    expect(result).toEqual({ prefix: '/', query: 'x', span: [7, 9], isLeading: false });
  });
});

describe('detectSlashTrigger — additional edge cases', () => {
  it('empty text, caret 0 — returns null', () => {
    expect(detectSlashTrigger('', 0)).toBeNull();
  });

  it('caret in the middle of a word — returns null', () => {
    // "hello" caret at 3 → 'l','l','e','h' all non-whitespace, no trigger
    expect(detectSlashTrigger('hello', 3)).toBeNull();
  });

  it('multiple / in text — selects latest valid trigger', () => {
    // "/clear /rev" caret at 11
    const result = detectSlashTrigger('/clear /rev', 11);
    expect(result).toEqual({ prefix: '/', query: 'rev', span: [7, 11], isLeading: false });
  });

  it('mixed $ and / — selects the one immediately behind caret', () => {
    // "hello $skill" caret at 12, should find $
    const result = detectSlashTrigger('hello $skill', 12);
    expect(result).toEqual({ prefix: '$', query: 'skill', span: [6, 12], isLeading: false });
  });

  it('mixed $ and / — other trigger prefix earlier is not picked', () => {
    // "/clear $skill" caret at 13 → $skill wins
    const result = detectSlashTrigger('/clear $skill', 13);
    expect(result).toEqual({ prefix: '$', query: 'skill', span: [7, 13], isLeading: false });
  });

  it('leading-with-newline form — isLeading true', () => {
    // "intro\n$skill" caret at 12
    const result = detectSlashTrigger('intro\n$skill', 12);
    expect(result).toEqual({ prefix: '$', query: 'skill', span: [6, 12], isLeading: true });
  });

  it('tab before trigger — isLeading false (tab is non-newline whitespace)', () => {
    const result = detectSlashTrigger('\t/cmd', 5);
    expect(result).toEqual({ prefix: '/', query: 'cmd', span: [1, 5], isLeading: false });
  });

  it('just $ at caret 1 — empty query trigger', () => {
    const result = detectSlashTrigger('$', 1);
    expect(result).toEqual({ prefix: '$', query: '', span: [0, 1], isLeading: true });
  });

  it('just / at caret 1 — empty query trigger', () => {
    const result = detectSlashTrigger('/', 1);
    expect(result).toEqual({ prefix: '/', query: '', span: [0, 1], isLeading: true });
  });

  it('caret at 0 on non-empty text — no trigger', () => {
    expect(detectSlashTrigger('/cmd', 0)).toBeNull();
  });

  it('caret inside trigger word, not at end', () => {
    // "/clear" caret at 3 → query is 'cl'
    const result = detectSlashTrigger('/clear', 3);
    expect(result).toEqual({ prefix: '/', query: 'cl', span: [0, 3], isLeading: true });
  });

  it('trigger only at caret=1 and text has leading char — non-whitespace precedes', () => {
    expect(detectSlashTrigger('a/cmd', 5)).toBeNull();
  });

  it('two newlines then trigger — leading', () => {
    const result = detectSlashTrigger('\n\n/cmd', 6);
    expect(result).toEqual({ prefix: '/', query: 'cmd', span: [2, 6], isLeading: true });
  });
});
