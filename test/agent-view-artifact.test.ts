import { describe, expect, it } from 'vitest';

import {
  AGENT_VIEW_CSP,
  AGENT_VIEW_MANIFEST_KIND,
  AGENT_VIEW_MAX_FILE_BYTES,
  AGENT_VIEW_MAX_FILES,
  AGENT_VIEW_MAX_TOTAL_BYTES,
  AGENT_VIEW_SCHEMA_VERSION,
  assembleInlinedHtml,
  isAgentViewArtifact,
  sanitizeAgentViewManifestForPublic,
  validateAgentViewArtifact,
  validatePublicAgentViewManifest,
  type AgentViewManifest,
  type AgentViewValidationCode,
  type ViewArtifactPackage,
} from '../shared/agent-view-artifact.js';

const now = '2026-06-10T01:02:03Z';

function manifest(overrides: Partial<AgentViewManifest> = {}): AgentViewManifest {
  return {
    kind: AGENT_VIEW_MANIFEST_KIND,
    schemaVersion: AGENT_VIEW_SCHEMA_VERSION,
    title: 'Repo dependency map',
    description: 'A read-only summary of module boundaries.',
    entry: 'index.html',
    authoring: { actorId: 'agent:kani-backend', harness: 'claude-code' },
    createdAt: now,
    updatedAt: now,
    scope: {
      repo: 'donovan-yohan/relay-ide',
      taskRefs: [{ kind: 'github-issue', id: '830' }],
    },
    sources: [
      {
        label: 'issue #830',
        url: 'https://github.com/donovan-yohan/relay-ide/issues/830',
        capturedAt: now,
        kind: 'github-issue',
      },
    ],
    capabilities: [],
    export: { policy: 'private' },
    revision: { id: 'rev-1' },
    ...overrides,
  };
}

function validPackage(overrides: Partial<ViewArtifactPackage> = {}): ViewArtifactPackage {
  return {
    manifest: manifest(),
    files: {
      'index.html': '<!doctype html><html><head><title>view</title></head><body><h1>hello</h1></body></html>',
      'styles.css': 'body { color: #0f0; }',
    },
    ...overrides,
  };
}

function codes(result: { errors: { code: AgentViewValidationCode }[] }): AgentViewValidationCode[] {
  return result.errors.map((e) => e.code);
}

describe('validateAgentViewArtifact — valid', () => {
  it('accepts a minimal valid package', () => {
    const result = validateAgentViewArtifact(validPackage());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(isAgentViewArtifact(validPackage())).toBe(true);
  });

  it('accepts a package with no css files', () => {
    const result = validateAgentViewArtifact(
      validPackage({
        files: { 'index.html': '<!doctype html><html><body>ok</body></html>' },
      })
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateAgentViewArtifact — entry rules', () => {
  it('rejects when entry is not in files', () => {
    const result = validateAgentViewArtifact(
      validPackage({
        manifest: manifest({ entry: 'missing.html' }),
        files: { 'index.html': '<!doctype html><html><body>ok</body></html>' },
      })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_invalid_entry');
  });

  it('rejects a non-html entry', () => {
    const result = validateAgentViewArtifact(
      validPackage({
        manifest: manifest({ entry: 'styles.css' }),
        files: { 'styles.css': 'body{}' },
      })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_invalid_entry');
  });

  it('rejects a missing entry', () => {
    const m = manifest();
    // @ts-expect-error intentionally drop entry
    delete m.entry;
    const result = validateAgentViewArtifact({ manifest: m, files: validPackage().files });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_invalid_entry');
  });
});

describe('validateAgentViewArtifact — path safety', () => {
  const unsafePaths = [
    '../escape.html',
    'a/../../escape.html',
    '/abs.html',
    'C:\\win.html',
    'dir\\back.html',
    'has\x00nul.html',
  ];
  for (const path of unsafePaths) {
    it(`rejects unsafe path ${JSON.stringify(path)}`, () => {
      const result = validateAgentViewArtifact(
        validPackage({
          manifest: manifest({ entry: 'index.html' }),
          files: {
            'index.html': '<html><body>ok</body></html>',
            [path]: 'body{}',
          },
        })
      );
      expect(result.valid).toBe(false);
      expect(codes(result)).toContain('view_unsafe_path');
    });
  }
});

describe('validateAgentViewArtifact — file allow-list', () => {
  for (const path of ['app.js', 'icon.svg', 'logo.png']) {
    it(`rejects unsupported file ${path}`, () => {
      const result = validateAgentViewArtifact(
        validPackage({
          files: {
            'index.html': '<html><body>ok</body></html>',
            [path]: 'data',
          },
        })
      );
      expect(result.valid).toBe(false);
      expect(codes(result)).toContain('view_unsupported_file');
    });
  }
});

describe('validateAgentViewArtifact — size caps', () => {
  it('rejects oversize per-file content', () => {
    const big = 'a'.repeat(AGENT_VIEW_MAX_FILE_BYTES + 1);
    const result = validateAgentViewArtifact(
      validPackage({
        files: {
          'index.html': '<html><body>ok</body></html>',
          'big.css': big,
        },
      })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_oversize');
  });

  it('rejects oversize total content', () => {
    const files: Record<string, string> = {
      'index.html': '<html><body>ok</body></html>',
    };
    // Several near-cap files that exceed the total cap together.
    const chunk = 'b'.repeat(AGENT_VIEW_MAX_FILE_BYTES);
    const needed = Math.ceil(AGENT_VIEW_MAX_TOTAL_BYTES / AGENT_VIEW_MAX_FILE_BYTES) + 1;
    for (let i = 0; i < needed; i += 1) {
      files[`f${i}.css`] = chunk;
    }
    const result = validateAgentViewArtifact(validPackage({ files }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_oversize');
  });

  it('rejects too many files', () => {
    const files: Record<string, string> = {
      'index.html': '<html><body>ok</body></html>',
    };
    for (let i = 0; i < AGENT_VIEW_MAX_FILES; i += 1) {
      files[`f${i}.css`] = 'x{}';
    }
    const result = validateAgentViewArtifact(validPackage({ files }));
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_oversize');
  });
});

describe('validateAgentViewArtifact — manifest schema', () => {
  it('rejects wrong kind', () => {
    const result = validateAgentViewArtifact(
      validPackage({ manifest: manifest({ kind: 'relay.other' as never }) })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_invalid_manifest');
  });

  it('rejects wrong schemaVersion', () => {
    const result = validateAgentViewArtifact(
      validPackage({ manifest: manifest({ schemaVersion: 2 as never }) })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_invalid_manifest');
  });

  it('rejects non-strict ISO timestamps', () => {
    const result = validateAgentViewArtifact(
      validPackage({ manifest: manifest({ createdAt: '2026-06-10 01:02:03' }) })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_invalid_manifest');
  });

  it('rejects secret-looking text in the manifest', () => {
    const result = validateAgentViewArtifact(
      validPackage({
        manifest: manifest({
          description: 'token: sk-abcdef0123456789 leaked here',
        }),
      })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_invalid_manifest');
  });
});

describe('validateAgentViewArtifact — capabilities denied', () => {
  it('rejects non-empty capabilities', () => {
    const result = validateAgentViewArtifact(
      validPackage({ manifest: manifest({ capabilities: ['network'] }) })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_capabilities_denied');
  });
});

describe('validateAgentViewArtifact — html/css tripwire', () => {
  const cases: Array<[string, string]> = [
    ['script tag', '<html><body><script>alert(1)</script></body></html>'],
    ['onerror handler', '<html><body><img src=x onerror="alert(1)"></body></html>'],
    ['javascript uri', '<html><body><a href="javascript:alert(1)">x</a></body></html>'],
    ['nested iframe', '<html><body><iframe src="https://evil"></iframe></body></html>'],
    ['object tag', '<html><body><object data="x"></object></body></html>'],
    ['embed tag', '<html><body><embed src="x"></body></html>'],
  ];
  for (const [name, html] of cases) {
    it(`rejects ${name} in entry html`, () => {
      const result = validateAgentViewArtifact(
        validPackage({ files: { 'index.html': html } })
      );
      expect(result.valid).toBe(false);
      expect(codes(result)).toContain('view_unsafe_html');
    });
  }

  it('rejects CSS that can break out of an inlined style block', () => {
    const result = validateAgentViewArtifact(
      validPackage({
        files: {
          'index.html': '<html><body>ok</body></html>',
          'breakout.css': 'body{} </style><iframe src="https://evil"></iframe>',
        },
      })
    );
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_unsafe_html');
  });
});

describe('sanitize + public manifest validation', () => {
  it('redacts secret-looking text from manifest only', () => {
    const m = manifest({ description: 'leak sk-abcdef0123456789 here' });
    const sanitized = sanitizeAgentViewManifestForPublic(m);
    expect(sanitized.description).not.toContain('sk-abcdef0123456789');
    expect(sanitized.description).toContain('[redacted-secret]');
  });

  it('rejects local absolute paths in public manifest', () => {
    const m = manifest({ description: 'see /home/agent/secret.txt for details' });
    const result = validatePublicAgentViewManifest(m);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('view_invalid_manifest');
  });

  it('accepts a clean public manifest', () => {
    const result = validatePublicAgentViewManifest(manifest());
    expect(result.valid).toBe(true);
  });
});

describe('assembleInlinedHtml', () => {
  it('inlines css in document order and includes the CSP meta', () => {
    const html = assembleInlinedHtml(
      validPackage({
        files: {
          'index.html': '<!doctype html><html><head><title>t</title></head><body>x</body></html>',
          'a.css': '.a{color:red}',
          'b.css': '.b{color:blue}',
        },
      })
    );
    expect(html).toContain(`content="${AGENT_VIEW_CSP}"`);
    expect(html).toContain('.a{color:red}');
    expect(html).toContain('.b{color:blue}');
    expect(html.indexOf('.a{color:red}')).toBeLessThan(html.indexOf('.b{color:blue}'));
  });

  it('strips <link rel=stylesheet> and <script> from the entry html', () => {
    const html = assembleInlinedHtml(
      validPackage({
        files: {
          'index.html':
            '<html><head><link rel="stylesheet" href="x.css"></head><body><script>bad()</script>ok</body></html>',
        },
      })
    );
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('bad()');
    expect(html).toContain('ok');
  });

  it('wraps content in a full document when no head/html is present', () => {
    const html = assembleInlinedHtml(
      validPackage({
        files: { 'index.html': '<h1>fragment</h1>' },
      })
    );
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<head>');
    expect(html).toContain(`content="${AGENT_VIEW_CSP}"`);
    expect(html).toContain('<h1>fragment</h1>');
  });

  it('keeps </iframe>, quotes, and </script>-like content inside the document body', () => {
    const payload = 'breakout </iframe>"\' </script> attempt';
    const html = assembleInlinedHtml(
      validPackage({
        files: {
          'index.html': `<!doctype html><html><head></head><body>${payload}</body></html>`,
        },
      })
    );
    // The raw text round-trips inside the assembled document (it is the srcdoc's
    // OWN document; the parent escapes the attribute when setting srcDoc).
    expect(html).toContain('breakout </iframe>"\'');
    // CSP meta is still present ahead of the payload.
    expect(html.indexOf(AGENT_VIEW_CSP)).toBeLessThan(html.indexOf('breakout'));
  });
});
