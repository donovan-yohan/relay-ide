export type TerminalAttentionKind = 'approval' | 'question';

export interface TerminalAttentionPrompt {
  kind: TerminalAttentionKind;
  source: 'terminal-model';
}

const APPROVAL_PROMPTS = [
  /do\s+you\s+want\s+to\s+proceed\?/i,
  /(?:allow|approve|authorize)\s+(?:this\s+)?(?:command|tool|action|operation)/i,
  /(?:command|tool|action|operation)\s+(?:requires|needs)\s+(?:your\s+)?(?:approval|permission)/i,
  /permission\s+(?:required|requested|prompt)/i,
  /\b(?:yes|allow|approve)\b[\s\S]{0,160}\b(?:no|deny|reject)\b/i,
];

const QUESTION_PROMPTS = [
  /(?:needs|requires|waiting\s+for)\s+(?:your\s+)?(?:answer|input|response)/i,
  /ask\s+user\s+question/i,
];

function normalizeVisibleText(text: string): string {
  const sanitized = Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  }).join('');
  return sanitized.replace(/\s+/g, ' ').trim();
}

export function detectTerminalAttentionPrompt(
  visibleText: string
): TerminalAttentionPrompt | null {
  const normalized = normalizeVisibleText(visibleText);
  if (!normalized) return null;

  if (APPROVAL_PROMPTS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'approval', source: 'terminal-model' };
  }

  if (QUESTION_PROMPTS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'question', source: 'terminal-model' };
  }

  return null;
}
