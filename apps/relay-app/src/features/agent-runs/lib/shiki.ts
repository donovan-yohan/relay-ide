import {
  getSingletonHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type HighlighterGeneric,
  type ThemedToken,
} from 'shiki';

export type { ThemedToken };

const tuiTheme: any = {
  name: 'tui',
  type: 'dark',
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#e0e0e0',
  },
  tokenColors: [
    {
      scope: ['keyword', 'storage.type', 'storage.modifier'],
      settings: { foreground: '#c792ea' },
    },
    {
      scope: ['entity.name.function', 'support.function'],
      settings: { foreground: '#82aaff' },
    },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#c3e88d' } },
    {
      scope: ['entity.name.type', 'support.type'],
      settings: { foreground: '#ffcb6b' },
    },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: '#888888' },
    },
    { scope: ['constant.numeric'], settings: { foreground: '#f78c6c' } },
    {
      scope: ['variable', 'variable.other'],
      settings: { foreground: '#e0e0e0' },
    },
    { scope: ['punctuation'], settings: { foreground: '#888888' } },
  ],
};

const PRELOAD_LANGS: BundledLanguage[] = [
  'typescript',
  'javascript',
  'json',
  'css',
  'diff' as BundledLanguage,
  'bash',
];

let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;

export function getHighlighter(): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  if (!highlighterPromise) {
    highlighterPromise = getSingletonHighlighter({
      themes: [tuiTheme],
      langs: PRELOAD_LANGS,
    }).catch((err) => {
      highlighterPromise = null;
      throw err;
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
    diff: 'diff' as BundledLanguage,
    patch: 'diff' as BundledLanguage,
  };
  return map[ext] ?? 'javascript';
}

const tokenCache = new Map<string, ThemedToken[][]>();

export async function tokenizeCode(
  code: string,
  lang: string
): Promise<ThemedToken[][]> {
  const cacheKey = `${lang}:${code.slice(0, 100)}:${code.length}`;
  if (tokenCache.has(cacheKey)) {
    return tokenCache.get(cacheKey)!;
  }

  try {
    const highlighter = await getHighlighter();
    const loadedLangs = highlighter.getLoadedLanguages();
    let resolvedLang = (lang || 'text') as BundledLanguage;
    if (!loadedLangs.includes(resolvedLang)) {
      try {
        await highlighter.loadLanguage(resolvedLang);
      } catch {
        resolvedLang = 'javascript';
      }
    }

    const { tokens } = highlighter.codeToTokens(code, {
      lang: resolvedLang,
      theme: 'tui' as any,
    });
    if (tokenCache.size > 200) {
      const firstKey = tokenCache.keys().next().value;
      if (firstKey) tokenCache.delete(firstKey);
    }
    tokenCache.set(cacheKey, tokens);
    return tokens;
  } catch (err) {
    console.warn('[Shiki] Failed to tokenize:', err);
    let currentOffset = 0;
    return code.split('\n').map((line) => {
      const token = { content: line, offset: currentOffset };
      currentOffset += line.length + 1;
      return [token as any];
    });
  }
}
