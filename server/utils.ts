// Strip ANSI escape sequences (CSI, OSC, charset, mode sequences)
export const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[\?[0-9;]*[hlm]|\x1b\[[0-9]*[ABCDJKH]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

const DIGITS_RE = /^\d+$/;

interface ParsedSemver {
  core: number[];
  pre: string | undefined;
}

function parseSemver(v: string): ParsedSemver {
  const withoutBuild = v.split('+', 1)[0]!;
  const idx = withoutBuild.indexOf('-');
  const corePart = idx === -1 ? withoutBuild : withoutBuild.slice(0, idx);
  const pre = idx === -1 ? undefined : withoutBuild.slice(idx + 1);
  return { core: corePart.split('.').map(Number), pre };
}

function comparePreIds(aId: string, bId: string): number {
  const aIsNum = DIGITS_RE.test(aId);
  const bIsNum = DIGITS_RE.test(bId);
  if (aIsNum && bIsNum) {
    return Number(aId) - Number(bId);
  }
  if (aIsNum !== bIsNum) {
    return aIsNum ? -1 : 1; // numeric < alphanumeric per semver
  }
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function comparePreRelease(
  aPre: string | undefined,
  bPre: string | undefined
): number {
  if (!aPre && !bPre) return 0;
  if (aPre && !bPre) return -1; // pre-release < release
  if (!aPre && bPre) return 1; // release > pre-release

  const aIds = aPre!.split('.');
  const bIds = bPre!.split('.');
  const len = Math.max(aIds.length, bIds.length);

  for (let i = 0; i < len; i++) {
    if (i >= aIds.length) return -1; // fewer identifiers = lower
    if (i >= bIds.length) return 1;
    const cmp = comparePreIds(aIds[i]!, bIds[i]!);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function semverLessThan(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  for (let i = 0; i < 3; i++) {
    const ai = pa.core[i] ?? 0;
    const bi = pb.core[i] ?? 0;
    if (ai !== bi) return ai < bi;
  }

  return comparePreRelease(pa.pre, pb.pre) < 0;
}

export function cleanEnv(): Record<string, string> {
  const env = Object.assign({}, process.env) as Record<string, string>;
  delete env.CLAUDECODE;
  return env;
}
