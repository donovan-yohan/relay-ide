/**
 * Rule-based smart summaries for diff content (v1).
 * Parses diff hunks to generate one-line descriptions of what changed.
 */

export function generateFileSummary(
  diffContent: string,
  _filePath: string,
  status: string
): string {
  if (status === 'deleted') return 'deleted file';
  if (status === 'untracked') {
    const firstMeaningfulLine = extractFirstMeaningfulLine(diffContent);
    if (firstMeaningfulLine) return `new file: ${firstMeaningfulLine}`;
    return 'new file';
  }

  const addedLines = diffContent
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const removedLines = diffContent
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'));

  // Detect added functions
  const addedFunctions = addedLines
    .map((l) => l.slice(1)) // strip leading +
    .map((l) => extractFunctionName(l))
    .filter(Boolean);

  if (addedFunctions.length === 1) {
    return `added ${addedFunctions[0]}()`;
  }
  if (addedFunctions.length > 1) {
    return `added ${addedFunctions.length} functions`;
  }

  // Detect modified functions from hunk headers
  const hunkFunctions = extractHunkFunctions(diffContent);
  if (hunkFunctions.length === 1) {
    return `modified ${addedLines.length} lines in ${hunkFunctions[0]}()`;
  }
  if (hunkFunctions.length > 1) {
    return `modified ${hunkFunctions.length} functions`;
  }

  // Fallback: +N -N lines
  return `+${addedLines.length} -${removedLines.length} lines`;
}

function extractFunctionName(line: string): string | null {
  // Match: function name, async function name, const name = (, export function name
  const match = line.match(
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/
  );
  if (match) return match[1] ?? match[2] ?? null;
  return null;
}

function extractFirstMeaningfulLine(diff: string): string | null {
  const lines = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).trim())
    .filter(
      (l) =>
        l &&
        !l.startsWith('import ') &&
        !l.startsWith('//') &&
        !l.startsWith('/*')
    );
  return lines[0]?.slice(0, 60) ?? null;
}

function extractHunkFunctions(diff: string): string[] {
  // Hunk headers: @@ -a,b +c,d @@ functionName
  const hunks = diff.match(/@@ .+? @@\s*(.+)/g) || [];
  return hunks
    .map((h) => {
      const match = h.match(
        /@@ .+? @@\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?(\w+)/
      );
      return match?.[1] ?? null;
    })
    .filter((name): name is string => name !== null && name !== 'function');
}
