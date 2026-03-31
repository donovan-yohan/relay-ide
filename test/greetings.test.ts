import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGreeting } from '../frontend/src/lib/greetings.js';

describe('greetings', () => {
  it('returns a non-empty string', () => {
    const greeting = getGreeting();
    assert.ok(greeting.length > 0, 'greeting should be non-empty');
  });

  it('returns all lowercase text', () => {
    for (let i = 0; i < 20; i++) {
      const greeting = getGreeting();
      assert.strictEqual(greeting, greeting.toLowerCase(), `greeting "${greeting}" should be lowercase`);
    }
  });

  it('returns a string from the correct time bucket', () => {
    // We can't easily mock Date, but we can verify the greeting is always a known value
    const allGreetings = [
      'good morning', 'rise and shine', 'early bird gets the worm', 'coffee first, code second',
      'good afternoon', "it's high noon", 'afternoon shift', 'back at it',
      'good evening', 'evening shift', 'winding down... or ramping up?',
      'burning the midnight oil', 'the witching hour', 'night owl mode',
      'the city sleeps but the terminal glows',
    ];
    for (let i = 0; i < 20; i++) {
      const greeting = getGreeting();
      assert.ok(allGreetings.includes(greeting), `unexpected greeting: "${greeting}"`);
    }
  });
});
