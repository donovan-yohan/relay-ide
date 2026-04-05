// Strip ANSI escape sequences (CSI, OSC, charset, mode sequences)
export const ANSI_RE =
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[\?[0-9;]*[hlm]|\x1b\[[0-9]*[ABCDJKH]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function semverLessThan(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    (v.split('-').at(0) ?? v).split('.').map(Number);
  const pa = parse(a);
  const pb = parse(b);
  const aMaj = pa[0] ?? 0,
    aMin = pa[1] ?? 0,
    aPat = pa[2] ?? 0;
  const bMaj = pb[0] ?? 0,
    bMin = pb[1] ?? 0,
    bPat = pb[2] ?? 0;
  if (aMaj !== bMaj) return aMaj < bMaj;
  if (aMin !== bMin) return aMin < bMin;
  return aPat < bPat;
}

export function cleanEnv(): Record<string, string> {
  const env = Object.assign({}, process.env) as Record<string, string>;
  delete env.CLAUDECODE;
  return env;
}
