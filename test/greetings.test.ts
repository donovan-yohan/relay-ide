import { describe, it, expect } from 'vitest';
import { getGreeting } from '../frontend/src/lib/greetings.js';

const morningGreetings = [
  'good morning',
  'rise and shine',
  'early bird gets the worm',
  'coffee first, code second',
];
const afternoonGreetings = [
  'good afternoon',
  "it's high noon",
  'afternoon shift',
  'back at it',
];
const eveningGreetings = [
  'good evening',
  'evening shift',
  'winding down... or ramping up?',
];
const nightGreetings = [
  'good evening',
  'burning the midnight oil',
  'the witching hour',
  'night owl mode',
  'the city sleeps but the terminal glows',
];
const allGreetings = [
  ...morningGreetings,
  ...afternoonGreetings,
  ...eveningGreetings,
  ...nightGreetings,
];

describe('greetings', () => {
  it('returns a non-empty string', () => {
    const greeting = getGreeting();
    expect(greeting.length).toBeGreaterThan(0);
  });

  it('returns all lowercase text', () => {
    for (let i = 0; i < 20; i++) {
      const greeting = getGreeting();
      expect(greeting).toBe(greeting.toLowerCase());
    }
  });

  it('returns a known greeting when called without hour', () => {
    for (let i = 0; i < 20; i++) {
      const greeting = getGreeting();
      expect(allGreetings).toContain(greeting);
    }
  });

  it('returns morning greetings for hours 5-11', () => {
    for (const hour of [5, 8, 11]) {
      for (let i = 0; i < 20; i++) {
        const greeting = getGreeting(hour);
        expect(morningGreetings).toContain(greeting);
      }
    }
  });

  it('returns afternoon greetings for hours 12-16', () => {
    for (const hour of [12, 14, 16]) {
      for (let i = 0; i < 20; i++) {
        const greeting = getGreeting(hour);
        expect(afternoonGreetings).toContain(greeting);
      }
    }
  });

  it('returns evening greetings for hours 17-20', () => {
    for (const hour of [17, 19, 20]) {
      for (let i = 0; i < 20; i++) {
        const greeting = getGreeting(hour);
        expect(eveningGreetings).toContain(greeting);
      }
    }
  });

  it('returns night greetings for hours 21-4', () => {
    for (const hour of [0, 2, 4, 21, 23]) {
      for (let i = 0; i < 20; i++) {
        const greeting = getGreeting(hour);
        expect(nightGreetings).toContain(greeting);
      }
    }
  });
});
