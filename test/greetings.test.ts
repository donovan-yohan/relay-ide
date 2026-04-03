import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(greeting.length > 0, 'greeting should be non-empty');
  });

  it('returns all lowercase text', () => {
    for (let i = 0; i < 20; i++) {
      const greeting = getGreeting();
      assert.strictEqual(
        greeting,
        greeting.toLowerCase(),
        `greeting "${greeting}" should be lowercase`
      );
    }
  });

  it('returns a known greeting when called without hour', () => {
    for (let i = 0; i < 20; i++) {
      const greeting = getGreeting();
      assert.ok(
        allGreetings.includes(greeting),
        `unexpected greeting: "${greeting}"`
      );
    }
  });

  it('returns morning greetings for hours 5-11', () => {
    for (const hour of [5, 8, 11]) {
      for (let i = 0; i < 20; i++) {
        const greeting = getGreeting(hour);
        assert.ok(
          morningGreetings.includes(greeting),
          `hour ${hour}: expected morning greeting, got "${greeting}"`
        );
      }
    }
  });

  it('returns afternoon greetings for hours 12-16', () => {
    for (const hour of [12, 14, 16]) {
      for (let i = 0; i < 20; i++) {
        const greeting = getGreeting(hour);
        assert.ok(
          afternoonGreetings.includes(greeting),
          `hour ${hour}: expected afternoon greeting, got "${greeting}"`
        );
      }
    }
  });

  it('returns evening greetings for hours 17-20', () => {
    for (const hour of [17, 19, 20]) {
      for (let i = 0; i < 20; i++) {
        const greeting = getGreeting(hour);
        assert.ok(
          eveningGreetings.includes(greeting),
          `hour ${hour}: expected evening greeting, got "${greeting}"`
        );
      }
    }
  });

  it('returns night greetings for hours 21-4', () => {
    for (const hour of [0, 2, 4, 21, 23]) {
      for (let i = 0; i < 20; i++) {
        const greeting = getGreeting(hour);
        assert.ok(
          nightGreetings.includes(greeting),
          `hour ${hour}: expected night greeting, got "${greeting}"`
        );
      }
    }
  });
});
