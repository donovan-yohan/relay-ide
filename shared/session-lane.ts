export const SESSION_LANES = ['local-repo', 'remote-cwd', 'remote-home'] as const;

export type SessionLane = (typeof SESSION_LANES)[number];

export function isSessionLane(value: unknown): value is SessionLane {
  return (
    typeof value === 'string' &&
    (SESSION_LANES as readonly string[]).includes(value)
  );
}
