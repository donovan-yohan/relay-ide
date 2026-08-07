const INITIAL_COLORS = [
  '#d97757',
  '#4ade80',
  '#60a5fa',
  '#a78bfa',
  '#f472b6',
  '#fb923c',
  '#34d399',
  '#f87171',
  '#fbbf24',
  '#38bdf8',
  '#a3e635',
  '#818cf8',
];

export function deriveColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length] ?? '#d97757';
}
