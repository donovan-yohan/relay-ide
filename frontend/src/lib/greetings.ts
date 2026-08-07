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
  evening: ['good evening', 'evening shift', 'winding down... or ramping up?'],
  night: [
    'good evening',
    'burning the midnight oil',
    'the witching hour',
    'night owl mode',
    'the city sleeps but the terminal glows',
  ],
};

export function getGreeting(hour?: number): string {
  const h = hour ?? new Date().getHours();
  const bucket =
    h >= 5 && h < 12
      ? 'morning'
      : h >= 12 && h < 17
        ? 'afternoon'
        : h >= 17 && h < 21
          ? 'evening'
          : 'night';
  const pool = GREETINGS[bucket]!;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
