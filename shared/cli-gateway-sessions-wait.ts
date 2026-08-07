export function retainOutputPredicateSuffix(outputWindow: string, predicateValue: string): string {
  const retainedSuffixLength = Math.max(0, predicateValue.length - 1);
  if (retainedSuffixLength === 0) return '';
  if (outputWindow.length <= retainedSuffixLength) return outputWindow;
  return outputWindow.slice(-retainedSuffixLength);
}
