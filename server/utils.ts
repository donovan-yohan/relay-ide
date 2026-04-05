// Strip ANSI escape sequences (CSI, OSC, charset, mode sequences)
export const ANSI_RE =
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[\?[0-9;]*[hlm]|\x1b\[[0-9]*[ABCDJKH]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function semverLessThan(a: string, b: string): boolean {
  const idxA = a.indexOf('-');
  const idxB = b.indexOf('-');
  const aCore = (idxA === -1 ? a : a.slice(0, idxA)).split('.').map(Number);
  const bCore = (idxB === -1 ? b : b.slice(0, idxB)).split('.').map(Number);
  const aPre = idxA === -1 ? undefined : a.slice(idxA + 1);
  const bPre = idxB === -1 ? undefined : b.slice(idxB + 1);

  for (let i = 0; i < 3; i++) {
    const ai = aCore[i] ?? 0;
    const bi = bCore[i] ?? 0;
    if (ai !== bi) return ai < bi;
  }

  // major.minor.patch equal — compare pre-release per semver spec
  if (!aPre && !bPre) return false;
  if (aPre && !bPre) return true; // pre-release < release
  if (!aPre && bPre) return false; // release > pre-release

  const aIds = aPre!.split('.');
  const bIds = bPre!.split('.');
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i++) {
    if (i >= aIds.length) return true; // fewer identifiers = lower
    if (i >= bIds.length) return false;
    const aNum = Number(aIds[i]);
    const bNum = Number(bIds[i]);
    const aIsNum = !isNaN(aNum);
    const bIsNum = !isNaN(bNum);
    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum < bNum;
    } else if (aIsNum !== bIsNum) {
      return aIsNum; // numeric < string per semver
    } else {
      if (aIds[i] !== bIds[i]) return aIds[i]! < bIds[i]!;
    }
  }
  return false;
}

export function cleanEnv(): Record<string, string> {
  const env = Object.assign({}, process.env) as Record<string, string>;
  delete env.CLAUDECODE;
  env.CLAUDE_CODE_NO_FLICKER = '1';
  return env;
}
