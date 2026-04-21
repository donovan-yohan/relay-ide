import { describe, it, expect } from 'vitest';
import {
  config,
  getPulseClass,
} from '../../frontend/src/components/SessionIndicator.js';

describe('SessionIndicator shape language', () => {
  it('running uses filled circle (●) with green', () => {
    expect(config.running).toEqual({
      char: '●',
      colorClass: 'ind-green',
      bold: false,
    });
  });

  it('initializing uses dimmed filled circle (●) with dim green', () => {
    expect(config.initializing).toEqual({
      char: '●',
      colorClass: 'ind-green-dim',
      bold: false,
    });
  });

  it('unseen-idle uses triangle (▶) with yellow and bold', () => {
    expect(config['unseen-idle']).toEqual({
      char: '▶',
      colorClass: 'ind-yellow',
      bold: true,
    });
  });

  it('seen-idle uses muted triangle (▶) with muted yellow', () => {
    expect(config['seen-idle']).toEqual({
      char: '▶',
      colorClass: 'ind-yellow-muted',
      bold: false,
    });
  });

  it('permission uses filled diamond (◆) with red and bold', () => {
    expect(config.permission).toEqual({
      char: '◆',
      colorClass: 'ind-red',
      bold: true,
    });
  });

  it('needs-answer uses hollow diamond (◇) with red and bold', () => {
    expect(config['needs-answer']).toEqual({
      char: '◇',
      colorClass: 'ind-red',
      bold: true,
    });
  });

  it('error uses square (■) with red and bold', () => {
    expect(config.error).toEqual({
      char: '■',
      colorClass: 'ind-red',
      bold: true,
    });
  });

  it('inactive uses dash (─) with gray', () => {
    expect(config.inactive).toEqual({
      char: '─',
      colorClass: 'ind-gray',
      bold: false,
    });
  });
});

describe('SessionIndicator pulse configuration', () => {
  it('permission and needs-answer have fast pulse (1.4s)', () => {
    expect(getPulseClass('permission')).toBe('pulse-fast');
    expect(getPulseClass('needs-answer')).toBe('pulse-fast');
  });

  it('unseen-idle has slow pulse (2.5s)', () => {
    expect(getPulseClass('unseen-idle')).toBe('pulse-slow');
  });

  it('error has no pulse', () => {
    expect(getPulseClass('error')).toBe('');
  });

  it('running has no pulse', () => {
    expect(getPulseClass('running')).toBe('');
  });

  it('inactive has no pulse', () => {
    expect(getPulseClass('inactive')).toBe('');
  });
});
