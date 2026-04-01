/**
 * Path-aware fuzzy scorer for file search.
 *
 * Inspired by VS Code's fuzzyScorer.ts. Scores query against filename
 * and full path separately, with filename matches weighted higher.
 * Returns match positions for highlight rendering.
 *
 * Scoring bonuses:
 *   consecutive match    +6 (first 3), +3 (after)
 *   start of word        +8
 *   after path separator +5
 *   camelCase transition +2
 *   same case            +1
 *   gap penalty          -3 (open), -1 (extend)
 */

export interface ScoredResult {
  score: number;
  /** Match ranges as [start, end) pairs into the full filePath */
  matches: [number, number][];
}

// ── Pre-filter ──────────────────────────────────────────────
// Fast check: do all query chars exist in the target (in order)?
// Avoids running the expensive DP scorer on non-candidates.

function preFilter(queryLower: string, targetLower: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
    if (targetLower[ti] === queryLower[qi]) qi++;
  }
  return qi === queryLower.length;
}

// ── Character scoring ───────────────────────────────────────

const CONSECUTIVE_BONUS_FIRST = 6;
const CONSECUTIVE_BONUS_AFTER = 3;
const CONSECUTIVE_THRESHOLD = 3;
const WORD_BOUNDARY_BONUS = 8;
const PATH_SEPARATOR_BONUS = 5;
const CAMEL_CASE_BONUS = 2;
const SAME_CASE_BONUS = 1;
const GAP_OPEN_PENALTY = -3;
const GAP_EXTEND_PENALTY = -1;

function isSeparator(ch: string): boolean {
  return ch === '/' || ch === '\\' || ch === '-' || ch === '_' || ch === '.' || ch === ' ';
}

function isUpperCase(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

function charScore(
  query: string, qi: number,
  target: string, ti: number,
  consecutive: number,
): number {
  let score = 1; // base match

  // Consecutive bonus
  if (consecutive > 0) {
    score += consecutive < CONSECUTIVE_THRESHOLD ? CONSECUTIVE_BONUS_FIRST : CONSECUTIVE_BONUS_AFTER;
  }

  // Word boundary / start of string
  if (ti === 0) {
    score += WORD_BOUNDARY_BONUS;
  } else if (isSeparator(target[ti - 1]!)) {
    const prev = target[ti - 1]!;
    score += prev === '/' || prev === '\\' ? PATH_SEPARATOR_BONUS : WORD_BOUNDARY_BONUS;
  }

  // CamelCase transition (uppercase after lowercase)
  if (ti > 0 && isUpperCase(target[ti]!) && !isUpperCase(target[ti - 1]!) && !isSeparator(target[ti - 1]!)) {
    score += CAMEL_CASE_BONUS;
  }

  // Same case bonus
  if (query[qi] === target[ti]) {
    score += SAME_CASE_BONUS;
  }

  return score;
}

// ── DP scorer ───────────────────────────────────────────────
// Scores query against target using a DP matrix. Returns the best
// score and the match positions (for highlighting).

interface DpResult {
  score: number;
  /** Matched character indices in target */
  positions: number[];
}

function scoreString(query: string, target: string): DpResult | null {
  const qLen = query.length;
  const tLen = target.length;
  if (qLen === 0 || tLen === 0 || qLen > tLen) return null;

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  if (!preFilter(queryLower, targetLower)) return null;

  // score[i][j] = best score matching query[0..i] against target[0..j]
  // consec[i][j] = consecutive match count ending at (i,j)
  // We use flat arrays for perf: index = i * tLen + j
  const size = qLen * tLen;
  const scores = new Float64Array(size);
  const consecutive = new Uint16Array(size);
  // Track whether each cell came from a diagonal (match) for backtracking
  const fromDiag = new Uint8Array(size);

  for (let i = 0; i < qLen; i++) {
    let hasMatch = false;
    for (let j = 0; j < tLen; j++) {
      const idx = i * tLen + j;

      if (queryLower[i] === targetLower[j]) {
        // Match: diagonal score + char bonus
        const prevConsec = (i > 0 && j > 0) ? (consecutive[(i - 1) * tLen + (j - 1)] ?? 0) : 0;
        const cs = charScore(query, i, target, j, prevConsec);

        let diagScore: number;
        if (i === 0 && j === 0) {
          diagScore = cs;
        } else if (i === 0) {
          diagScore = cs; // first query char, no prior row
        } else if (j === 0) {
          diagScore = -Infinity; // can't match query[i>0] at target[0] without prior
        } else {
          diagScore = (scores[(i - 1) * tLen + (j - 1)] ?? 0) + cs;
        }

        // Gap: skip this target char (take best from left)
        const gapScore = j > 0 ? (scores[idx - 1] ?? 0) + (fromDiag[idx - 1] ? GAP_OPEN_PENALTY : GAP_EXTEND_PENALTY) : -Infinity;

        if (diagScore >= gapScore) {
          scores[idx] = diagScore;
          consecutive[idx] = (prevConsec as number) + 1;
          fromDiag[idx] = 1;
        } else {
          scores[idx] = gapScore;
          consecutive[idx] = 0;
          fromDiag[idx] = 0;
        }
        hasMatch = true;
      } else {
        // No match: propagate from left with gap penalty
        if (j > 0) {
          const penalty = fromDiag[idx - 1] ? GAP_OPEN_PENALTY : GAP_EXTEND_PENALTY;
          scores[idx] = (scores[idx - 1] ?? 0) + penalty;
        } else {
          scores[idx] = -Infinity;
        }
        consecutive[idx] = 0;
        fromDiag[idx] = 0;
      }
    }
    if (!hasMatch) return null; // query char not found anywhere in remaining target
  }

  // Find best score in last query row
  let bestScore = -Infinity;
  let bestJ = -1;
  const lastRow = (qLen - 1) * tLen;
  for (let j = 0; j < tLen; j++) {
    const val = scores[lastRow + j] ?? 0;
    if (val > bestScore) {
      bestScore = val;
      bestJ = j;
    }
  }

  if (bestScore <= 0 || bestJ < 0) return null;

  // Backtrack to find match positions
  const positions: number[] = [];
  let i = qLen - 1;
  let j = bestJ;
  while (i >= 0 && j >= 0) {
    const idx = i * tLen + j;
    if (fromDiag[idx]) {
      positions.push(j);
      i--;
      j--;
    } else {
      j--;
    }
  }
  positions.reverse();

  return { score: bestScore, positions };
}

// ── Path scorer ─────────────────────────────────────────────
// Splits path into filename + directory, scores filename with a
// large boost so "app" matches App.svelte before src/app/index.ts.

const FILENAME_PREFIX_BOOST = 10_000;
const FILENAME_MATCH_BOOST = 5_000;

function positionsToRanges(positions: number[]): [number, number][] {
  if (positions.length === 0) return [];
  const ranges: [number, number][] = [];
  let start = positions[0]!;
  let end = start + 1;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === end) {
      end++;
    } else {
      ranges.push([start, end]);
      start = positions[i]!;
      end = start + 1;
    }
  }
  ranges.push([start, end]);
  return ranges;
}

export function scorePath(query: string, filePath: string): ScoredResult | null {
  if (!query || !filePath) return null;

  const lastSep = filePath.lastIndexOf('/');
  const filename = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath;
  const dirOffset = lastSep >= 0 ? lastSep + 1 : 0;

  // Try filename first (primary signal)
  const fnResult = scoreString(query, filename);
  if (fnResult && fnResult.score > 0) {
    // Shift positions to be relative to the full path
    const shiftedPositions = fnResult.positions.map(p => p + dirOffset);

    // Prefix boost: if the filename starts with the query
    const isPrefix = filename.toLowerCase().startsWith(query.toLowerCase());
    const boost = isPrefix ? FILENAME_PREFIX_BOOST : FILENAME_MATCH_BOOST;

    // Compactness bonus: reward filenames where query covers more of the name
    const compactness = Math.floor((query.length / filename.length) * 100);

    // Path length penalty: prefer shorter paths (fewer directory levels)
    const pathPenalty = Math.floor(filePath.length * 0.5);

    return {
      score: fnResult.score + boost + compactness - pathPenalty,
      matches: positionsToRanges(shiftedPositions),
    };
  }

  // Fallback: score against full path
  const pathResult = scoreString(query, filePath);
  if (pathResult && pathResult.score > 0) {
    // Path-only matches get a path length penalty too
    const pathPenalty = Math.floor(filePath.length * 0.5);
    return {
      score: pathResult.score - pathPenalty,
      matches: positionsToRanges(pathResult.positions),
    };
  }

  return null;
}
