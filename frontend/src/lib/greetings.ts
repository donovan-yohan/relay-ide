const GREETINGS: Record<string, string[]> = {
  morning: [
    'good morning',
    'rise and shine',
    'early bird gets the worm',
    'coffee first, code second',
  ],
  afternoon: [
    'good afternoon',
    "it's high noon",
    'afternoon shift',
    'back at it',
  ],
  evening: [
    'good evening',
    'evening shift',
    'winding down... or ramping up?',
  ],
  night: [
    'good evening',
    'burning the midnight oil',
    'the witching hour',
    'night owl mode',
    'the city sleeps but the terminal glows',
  ],
};

export function getGreeting(): string {
  const hour = new Date().getHours();
  const bucket =
    hour >= 5 && hour < 12
      ? 'morning'
      : hour >= 12 && hour < 17
        ? 'afternoon'
        : hour >= 17 && hour < 21
          ? 'evening'
          : 'night';
  const pool = GREETINGS[bucket]!;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
