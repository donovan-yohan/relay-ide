import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import type { ThemedToken } from 'shiki';

export type { ThemedToken };

// Custom TUI theme matching DESIGN.md colors
const tuiTheme = {
  name: 'tui',
  type: 'dark' as const,
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#e0e0e0',
  },
  tokenColors: [
    { scope: ['keyword', 'storage.type', 'storage.modifier'], settings: { foreground: '#c792ea' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#82aaff' } },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#c3e88d' } },
    { scope: ['entity.name.type', 'support.type'], settings: { foreground: '#ffcb6b' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#888888' } },
    { scope: ['constant.numeric'], settings: { foreground: '#f78c6c' } },
    { scope: ['variable', 'variable.other'], settings: { foreground: '#e0e0e0' } },
    { scope: ['punctuation'], settings: { foreground: '#888888' } },
  ],
};

const PRELOAD_LANGS: BundledLanguage[] = ['typescript', 'javascript', 'json', 'css', 'svelte'];

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [tuiTheme],
      langs: PRELOAD_LANGS,
    });
  }
  return highlighterPromise;
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, BundledLanguage> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    css: 'css',
    svelte: 'svelte',
    html: 'html',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
  };
  return map[ext] ?? 'javascript';
}

export async function tokenizeCode(code: string, lang: string): Promise<ThemedToken[][]> {
  const highlighter = await getHighlighter();

  const loadedLangs = highlighter.getLoadedLanguages();
  let resolvedLang = lang as BundledLanguage;
  if (!loadedLangs.includes(resolvedLang)) {
    try {
      await highlighter.loadLanguage(resolvedLang);
    } catch {
      resolvedLang = 'javascript';
    }
  }

  const { tokens } = highlighter.codeToTokens(code, {
    lang: resolvedLang,
    theme: 'tui',
  });
  return tokens;
}
