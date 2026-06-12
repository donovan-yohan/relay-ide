import type { TaskRef } from './work-context.js';

/**
 * Agent view artifact — a bounded, agent-authored HTML/CSS package rendered as a
 * read-only, fully isolated artifact in the workspace evidence surface.
 *
 * THREAT MODEL (this is agent-authored HTML; treat every byte as hostile):
 * - The ONLY sanctioned render path is an iframe with `srcDoc` + `sandbox=""`
 *   (the EMPTY string — no `allow-scripts`, no `allow-same-origin`, never a
 *   fetchable `src=`). Scripts are inert; there is no same-origin access; the
 *   document cannot reach the parent, cookies, storage, or network.
 * - `assembleInlinedHtml` produces a single inlined HTML document that begins
 *   with a `<meta http-equiv="Content-Security-Policy">` of
 *   `default-src 'none'; style-src 'unsafe-inline'; img-src data:` —
 *   belt-and-suspenders even though the empty sandbox already neuters scripts.
 * - Publish-time validation is defense in depth, NOT the primary control: it
 *   rejects `<script`, inline `on*=` handlers, `javascript:` URIs, and
 *   `<iframe`/`<object`/`<embed`; rejects non-`.html`/`.css` files and path
 *   traversal; rejects any declared capability (MVP denies all); enforces tight
 *   size/count caps before the generic publish cap.
 */

export const AGENT_VIEW_SCHEMA_VERSION = 1 as const;

export const AGENT_VIEW_MANIFEST_KIND = 'relay.agentView' as const;

export const AGENT_VIEW_MAX_TOTAL_BYTES = 512 * 1024;
export const AGENT_VIEW_MAX_FILE_BYTES = 64 * 1024;
export const AGENT_VIEW_MAX_FILES = 16;

export const AGENT_VIEW_MAX_TITLE_LENGTH = 200;
export const AGENT_VIEW_MAX_DESCRIPTION_LENGTH = 2000;

export const AGENT_VIEW_EXPORT_POLICIES = ['private', 'public'] as const;
export type AgentViewExportPolicy = (typeof AGENT_VIEW_EXPORT_POLICIES)[number];

/**
 * Belt-and-suspenders CSP injected into the assembled document head. The empty
 * sandbox already disables scripts; this denies network/media/frame loads too.
 */
export const AGENT_VIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export interface AgentViewAuthoring {
  actorId: string;
  harness?: string;
}

export interface AgentViewScope {
  repo?: string;
  taskRefs: TaskRef[];
}

export const AGENT_VIEW_SOURCE_KINDS = [
  'github-issue',
  'github-pr',
  'doc',
  'commit',
  'url',
  'other',
] as const;
export type AgentViewSourceKind = (typeof AGENT_VIEW_SOURCE_KINDS)[number];

export interface AgentViewSource {
  label: string;
  url: string;
  capturedAt?: string;
  kind?: AgentViewSourceKind;
}

export interface AgentViewExport {
  policy: AgentViewExportPolicy;
}

export interface AgentViewRevision {
  id: string;
  supersedes?: string;
}

export interface AgentViewManifest {
  kind: typeof AGENT_VIEW_MANIFEST_KIND;
  schemaVersion: typeof AGENT_VIEW_SCHEMA_VERSION;
  title: string;
  description?: string;
  /** Relative path of the entry HTML file. Must be present in `files` and end `.html`. */
  entry: string;
  authoring: AgentViewAuthoring;
  createdAt: string;
  updatedAt: string;
  scope: AgentViewScope;
  sources: AgentViewSource[];
  /** MVP denies all capabilities; this MUST be an empty array. */
  capabilities: string[];
  export: AgentViewExport;
  revision: AgentViewRevision;
}

export interface ViewArtifactPackage {
  manifest: AgentViewManifest;
  /** Map of relative file path -> file content (HTML/CSS only). */
  files: Record<string, string>;
}

export interface AgentViewValidationError {
  code: AgentViewValidationCode;
  message: string;
}

export type AgentViewValidationCode =
  | 'view_invalid_manifest'
  | 'view_invalid_entry'
  | 'view_unsafe_path'
  | 'view_unsupported_file'
  | 'view_oversize'
  | 'view_capabilities_denied'
  | 'view_unsafe_html';

export interface AgentViewValidationResult {
  valid: boolean;
  errors: AgentViewValidationError[];
}

// --- shared helpers -------------------------------------------------------

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// Secret/credential redaction block — mirrors shared/pipeline-handoff-artifact.ts.
const SECRET_TEXT_RE =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|sk-[a-z0-9_-]{8,}|relay-(?:sac|ohg|grant|auth|pair)-v1[a-z0-9._-]*|pair_[a-z0-9_-]{8,}|node_[a-z0-9._~+/=-]+\.secret_[a-z0-9._~+/=-]+|secret_[a-z0-9._~+/=-]+)/gi;
const ABSOLUTE_LOCAL_PATH_RE =
  /(?:^|[\s:=('"])(?:\/home\/[^\s)'"]+|\/Users\/[^\s)'"]+|\/tmp\/[^\s)'"]+)/g;
const WINDOWS_ABSOLUTE_PATH_RE = /(?:^|[\s:=('"])[a-z]:[\\/][^\s)'"]+/gi;
const UNC_PATH_RE = /(?:^|[\s:=('"])\\\\[^\s\\/'"]+[\\/][^\s)'"]+/g;
const KANBAN_TASK_ID_RE = /\bt_[a-f0-9]{8,}\b/gi;

// HTML tripwire patterns — defense in depth, NOT the primary control.
const HTML_SCRIPT_RE = /<script[\s>]/i;
const HTML_SCRIPT_CLOSE_RE = /<\/script\s*>/i;
const HTML_INLINE_HANDLER_RE = /\son[a-z][a-z0-9-]*\s*=/i;
const HTML_JAVASCRIPT_URI_RE = /javascript\s*:/i;
const HTML_DANGEROUS_TAG_RE = /<(?:iframe|object|embed)[\s>]/i;
const CSS_RAW_HTML_BREAKOUT_RE = /<\/?(?:style|script|iframe|object|embed|html|body|head)\b/i;

// `<link rel="stylesheet">` / `<script>` stripping for assembleInlinedHtml.
const LINK_STYLESHEET_TAG_RE =
  /<link\b[^>]*\brel\s*=\s*(?:["']?)stylesheet(?:["']?)[^>]*>/gi;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const SCRIPT_SELFCLOSE_RE = /<script\b[^>]*\/?>/gi;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const HTML_OPEN_RE = /<html\b[^>]*>/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

/** Path safety: reject `..`, leading `/`, drive/UNC, backslash, and NUL. */
function isSafeFilePath(value: string): boolean {
  if (value.length === 0) return false;
  // Reject NUL, control chars, and whitespace outright.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\s]/.test(value)) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (isWindowsAbsolutePath(value)) return false;
  // Treat any `..` segment as traversal.
  const segments = value.split('/');
  if (segments.some((segment) => segment === '..')) return false;
  if (value.includes('..')) return false;
  return true;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return '';
  return path.slice(dot).toLowerCase();
}

function manifestTextNodes(
  value: unknown,
  path: string,
  out: Array<{ path: string; text: string }>
): void {
  if (typeof value === 'string') {
    out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      manifestTextNodes(item, `${path}[${index}]`, out)
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    manifestTextNodes(nested, `${path}.${key}`, out);
  }
}

function containsSecretText(value: string): boolean {
  SECRET_TEXT_RE.lastIndex = 0;
  return SECRET_TEXT_RE.test(value);
}

// --- manifest validation --------------------------------------------------

function validateManifest(
  manifest: unknown,
  errors: AgentViewValidationError[]
): manifest is AgentViewManifest {
  if (!isRecord(manifest)) {
    errors.push({
      code: 'view_invalid_manifest',
      message: 'manifest must be an object',
    });
    return false;
  }
  let ok = true;
  const push = (code: AgentViewValidationCode, message: string): void => {
    errors.push({ code, message });
    ok = false;
  };

  if (manifest.kind !== AGENT_VIEW_MANIFEST_KIND) {
    push('view_invalid_manifest', `manifest.kind must be ${AGENT_VIEW_MANIFEST_KIND}`);
  }
  if (manifest.schemaVersion !== AGENT_VIEW_SCHEMA_VERSION) {
    push('view_invalid_manifest', 'manifest.schemaVersion is unsupported');
  }
  if (!hasString(manifest.title)) {
    push('view_invalid_manifest', 'manifest.title is required');
  } else if (manifest.title.length > AGENT_VIEW_MAX_TITLE_LENGTH) {
    push(
      'view_invalid_manifest',
      `manifest.title must be <= ${AGENT_VIEW_MAX_TITLE_LENGTH} chars`
    );
  }
  if (manifest.description !== undefined) {
    if (typeof manifest.description !== 'string') {
      push('view_invalid_manifest', 'manifest.description must be a string');
    } else if (manifest.description.length > AGENT_VIEW_MAX_DESCRIPTION_LENGTH) {
      push(
        'view_invalid_manifest',
        `manifest.description must be <= ${AGENT_VIEW_MAX_DESCRIPTION_LENGTH} chars`
      );
    }
  }
  if (!hasString(manifest.entry)) {
    push('view_invalid_entry', 'manifest.entry is required');
  }

  if (!isRecord(manifest.authoring) || !hasString(manifest.authoring.actorId)) {
    push('view_invalid_manifest', 'manifest.authoring.actorId is required');
  } else if (!isOptionalString(manifest.authoring.harness)) {
    push('view_invalid_manifest', 'manifest.authoring.harness must be a string');
  }

  if (!isIsoTimestamp(manifest.createdAt)) {
    push('view_invalid_manifest', 'manifest.createdAt must be a strict ISO timestamp');
  }
  if (!isIsoTimestamp(manifest.updatedAt)) {
    push('view_invalid_manifest', 'manifest.updatedAt must be a strict ISO timestamp');
  }

  if (!isRecord(manifest.scope)) {
    push('view_invalid_manifest', 'manifest.scope is required');
  } else {
    if (!isOptionalString(manifest.scope.repo)) {
      push('view_invalid_manifest', 'manifest.scope.repo must be a string');
    }
    if (!Array.isArray(manifest.scope.taskRefs)) {
      push('view_invalid_manifest', 'manifest.scope.taskRefs must be an array');
    } else {
      manifest.scope.taskRefs.forEach((taskRef, index) => {
        if (!isRecord(taskRef) || !hasString(taskRef.kind) || !hasString(taskRef.id)) {
          push(
            'view_invalid_manifest',
            `manifest.scope.taskRefs[${index}] must have kind and id`
          );
        }
      });
    }
  }

  if (!Array.isArray(manifest.sources)) {
    push('view_invalid_manifest', 'manifest.sources must be an array');
  } else {
    manifest.sources.forEach((source, index) => {
      const prefix = `manifest.sources[${index}]`;
      if (!isRecord(source)) {
        push('view_invalid_manifest', `${prefix} must be an object`);
        return;
      }
      if (!hasString(source.label)) {
        push('view_invalid_manifest', `${prefix}.label is required`);
      }
      if (!hasString(source.url)) {
        push('view_invalid_manifest', `${prefix}.url is required`);
      }
      if (source.capturedAt !== undefined && !isIsoTimestamp(source.capturedAt)) {
        push('view_invalid_manifest', `${prefix}.capturedAt must be a strict ISO timestamp`);
      }
      if (
        source.kind !== undefined &&
        !AGENT_VIEW_SOURCE_KINDS.includes(source.kind as AgentViewSourceKind)
      ) {
        push('view_invalid_manifest', `${prefix}.kind is invalid`);
      }
    });
  }

  if (!Array.isArray(manifest.capabilities)) {
    push('view_capabilities_denied', 'manifest.capabilities must be an array');
  } else if (manifest.capabilities.length > 0) {
    push(
      'view_capabilities_denied',
      'manifest.capabilities must be empty in MVP (all capabilities denied)'
    );
  }

  if (
    !isRecord(manifest.export) ||
    !AGENT_VIEW_EXPORT_POLICIES.includes(manifest.export.policy as AgentViewExportPolicy)
  ) {
    push('view_invalid_manifest', 'manifest.export.policy must be private or public');
  }

  if (!isRecord(manifest.revision) || !hasString(manifest.revision.id)) {
    push('view_invalid_manifest', 'manifest.revision.id is required');
  } else if (!isOptionalString(manifest.revision.supersedes)) {
    push('view_invalid_manifest', 'manifest.revision.supersedes must be a string');
  }

  return ok;
}

// --- HTML tripwire --------------------------------------------------------

function scanHtmlForUnsafeContent(
  path: string,
  content: string,
  errors: AgentViewValidationError[]
): void {
  if (HTML_SCRIPT_RE.test(content) || HTML_SCRIPT_CLOSE_RE.test(content)) {
    errors.push({
      code: 'view_unsafe_html',
      message: `${path} contains a <script> tag`,
    });
  }
  if (HTML_INLINE_HANDLER_RE.test(content)) {
    errors.push({
      code: 'view_unsafe_html',
      message: `${path} contains an inline on*= event handler`,
    });
  }
  if (HTML_JAVASCRIPT_URI_RE.test(content)) {
    errors.push({
      code: 'view_unsafe_html',
      message: `${path} contains a javascript: URI`,
    });
  }
  if (HTML_DANGEROUS_TAG_RE.test(content)) {
    errors.push({
      code: 'view_unsafe_html',
      message: `${path} contains an <iframe>/<object>/<embed> tag`,
    });
  }
}

function scanCssForUnsafeContent(
  path: string,
  content: string,
  errors: AgentViewValidationError[]
): void {
  if (CSS_RAW_HTML_BREAKOUT_RE.test(content)) {
    errors.push({
      code: 'view_unsafe_html',
      message: `${path} contains raw HTML that can break out of a <style> block`,
    });
  }
}

function validateEntryReference(
  manifest: Record<string, unknown> | undefined,
  files: Record<string, unknown>,
  errors: AgentViewValidationError[]
): void {
  const entry = manifest && typeof manifest.entry === 'string' ? manifest.entry : undefined;
  if (entry === undefined) return;
  if (fileExtension(entry) !== '.html') {
    errors.push({
      code: 'view_invalid_entry',
      message: 'manifest.entry must be an .html file',
    });
  }
  if (!Object.prototype.hasOwnProperty.call(files, entry)) {
    errors.push({
      code: 'view_invalid_entry',
      message: `manifest.entry ${JSON.stringify(entry)} must exist in files`,
    });
  }
}

function rejectManifestSecrets(
  manifest: Record<string, unknown> | undefined,
  errors: AgentViewValidationError[]
): void {
  if (manifest === undefined) return;
  const nodes: Array<{ path: string; text: string }> = [];
  manifestTextNodes(manifest, 'manifest', nodes);
  for (const node of nodes) {
    if (containsSecretText(node.text)) {
      errors.push({
        code: 'view_invalid_manifest',
        message: `secret-looking text rejected from manifest: ${node.path}`,
      });
    }
  }
}

// --- package validation ---------------------------------------------------

export function validateAgentViewArtifact(
  pkg: unknown
): AgentViewValidationResult {
  const errors: AgentViewValidationError[] = [];
  if (!isRecord(pkg)) {
    return {
      valid: false,
      errors: [{ code: 'view_invalid_manifest', message: 'package must be an object' }],
    };
  }

  validateManifest(pkg.manifest, errors);

  const files = pkg.files;
  if (!isRecord(files)) {
    errors.push({
      code: 'view_invalid_manifest',
      message: 'package.files must be an object map of path -> content',
    });
    return { valid: errors.length === 0, errors };
  }

  const filePaths = Object.keys(files);
  if (filePaths.length === 0) {
    errors.push({ code: 'view_invalid_entry', message: 'package.files must not be empty' });
  }
  if (filePaths.length > AGENT_VIEW_MAX_FILES) {
    errors.push({
      code: 'view_oversize',
      message: `package may contain at most ${AGENT_VIEW_MAX_FILES} files`,
    });
  }

  let totalBytes = 0;
  for (const path of filePaths) {
    const content = files[path];
    if (typeof content !== 'string') {
      errors.push({
        code: 'view_unsupported_file',
        message: `file ${path} content must be a string`,
      });
      continue;
    }
    if (!isSafeFilePath(path)) {
      errors.push({
        code: 'view_unsafe_path',
        message: `file path ${JSON.stringify(path)} is unsafe (traversal/absolute/backslash/NUL)`,
      });
      continue;
    }
    const ext = fileExtension(path);
    if (ext !== '.html' && ext !== '.css') {
      errors.push({
        code: 'view_unsupported_file',
        message: `file ${path} must be .html or .css`,
      });
      continue;
    }
    const size = byteLength(content);
    totalBytes += size;
    if (size > AGENT_VIEW_MAX_FILE_BYTES) {
      errors.push({
        code: 'view_oversize',
        message: `file ${path} exceeds per-file cap of ${AGENT_VIEW_MAX_FILE_BYTES} bytes`,
      });
    }
    if (ext === '.html') {
      scanHtmlForUnsafeContent(path, content, errors);
    }
    if (ext === '.css') {
      scanCssForUnsafeContent(path, content, errors);
    }
  }

  if (totalBytes > AGENT_VIEW_MAX_TOTAL_BYTES) {
    errors.push({
      code: 'view_oversize',
      message: `package exceeds total cap of ${AGENT_VIEW_MAX_TOTAL_BYTES} bytes`,
    });
  }

  // Entry must be a present `.html` file.
  const manifest = isRecord(pkg.manifest) ? pkg.manifest : undefined;
  validateEntryReference(manifest, files, errors);

  // Secret-pattern rejection over all manifest text.
  rejectManifestSecrets(manifest, errors);

  return { valid: errors.length === 0, errors };
}

export function isAgentViewArtifact(pkg: unknown): pkg is ViewArtifactPackage {
  return validateAgentViewArtifact(pkg).valid;
}

// --- public redaction (manifest text only) --------------------------------

function redactPublicText(value: string): string {
  SECRET_TEXT_RE.lastIndex = 0;
  ABSOLUTE_LOCAL_PATH_RE.lastIndex = 0;
  WINDOWS_ABSOLUTE_PATH_RE.lastIndex = 0;
  UNC_PATH_RE.lastIndex = 0;
  KANBAN_TASK_ID_RE.lastIndex = 0;
  return value
    .replace(SECRET_TEXT_RE, '[redacted-secret]')
    .replace(ABSOLUTE_LOCAL_PATH_RE, (match) => {
      const prefix = " \t:=('\"".includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(WINDOWS_ABSOLUTE_PATH_RE, (match) => {
      const prefix = " \t:=('\"".includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(UNC_PATH_RE, (match) => {
      const prefix = " \t:=('\"".includes(match[0] ?? '') ? match[0] : '';
      return `${prefix}[redacted-local-path]`;
    })
    .replace(KANBAN_TASK_ID_RE, '[redacted-kanban-task]');
}

function sanitizeTextTree<T>(value: T): T {
  if (typeof value === 'string') return redactPublicText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeTextTree(item)) as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = sanitizeTextTree(nested);
  }
  return out as T;
}

/**
 * Redact secret-looking values, local paths, and private Kanban ids from
 * MANIFEST TEXT ONLY. HTML/CSS files are NOT touched — the file bytes are
 * rendered verbatim inside the sandboxed iframe.
 */
export function sanitizeAgentViewManifestForPublic(
  manifest: AgentViewManifest
): AgentViewManifest {
  return sanitizeTextTree(JSON.parse(JSON.stringify(manifest)) as AgentViewManifest);
}

function collectUnsafePublicText(
  value: unknown,
  path: string,
  errors: AgentViewValidationError[]
): void {
  if (typeof value === 'string') {
    SECRET_TEXT_RE.lastIndex = 0;
    ABSOLUTE_LOCAL_PATH_RE.lastIndex = 0;
    WINDOWS_ABSOLUTE_PATH_RE.lastIndex = 0;
    UNC_PATH_RE.lastIndex = 0;
    KANBAN_TASK_ID_RE.lastIndex = 0;
    if (SECRET_TEXT_RE.test(value)) {
      errors.push({
        code: 'view_invalid_manifest',
        message: `secret-looking text rejected from public manifest: ${path}`,
      });
    }
    if (
      ABSOLUTE_LOCAL_PATH_RE.test(value) ||
      WINDOWS_ABSOLUTE_PATH_RE.test(value) ||
      UNC_PATH_RE.test(value)
    ) {
      errors.push({
        code: 'view_invalid_manifest',
        message: `local absolute path rejected from public manifest: ${path}`,
      });
    }
    if (KANBAN_TASK_ID_RE.test(value)) {
      errors.push({
        code: 'view_invalid_manifest',
        message: `private Kanban task id rejected from public manifest: ${path}`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectUnsafePublicText(item, `${path}[${index}]`, errors)
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    collectUnsafePublicText(nested, `${path}.${key}`, errors);
  }
}

/**
 * Validate that a manifest (text only) is safe to publish under a `public`
 * export policy. Does NOT inspect HTML/CSS files.
 */
export function validatePublicAgentViewManifest(
  manifest: AgentViewManifest
): AgentViewValidationResult {
  const errors: AgentViewValidationError[] = [];
  validateManifest(manifest, errors);
  collectUnsafePublicText(manifest, 'manifest', errors);
  return { valid: errors.length === 0, errors };
}

// --- inlined HTML assembly ------------------------------------------------

/**
 * Build the single inlined HTML document used as the iframe `srcDoc`.
 *
 * THREAT MODEL FOR THE OUTPUT:
 * The returned string becomes the `srcDoc` of an `<iframe sandbox="">`. Because
 * the sandbox is the empty string, scripts are inert and the document has NO
 * same-origin access — even if hostile bytes survive, they cannot reach the
 * parent context, cookies, storage, or network. This function does NOT attempt
 * to "clean" arbitrary HTML; the validator already rejected scripts/handlers.
 * Here we only:
 *   1. inline every `.css` file as a `<style>` block in document order;
 *   2. defensively strip `<link rel="stylesheet">` and `<script>` from the
 *      entry HTML so they cannot fetch or execute even outside the validator;
 *   3. prepend the CSP `<meta>` into `<head>` (wrapping if absent).
 *
 * Content that looks like `</iframe>`, stray quotes, or `</script>` inside the
 * document is harmless: it lives INSIDE the assembled HTML document that the
 * browser parses as the srcdoc's own document, not in the parent. The caller is
 * responsible for HTML-attribute-escaping this string when it sets the literal
 * `srcdoc="..."` attribute (React's `srcDoc` prop does this automatically).
 */
export function assembleInlinedHtml(pkg: ViewArtifactPackage): string {
  const { manifest, files } = pkg;
  const entryHtmlRaw = files[manifest.entry] ?? '';

  // 1. Strip <link rel=stylesheet> and <script> from the entry document.
  const entryHtml = entryHtmlRaw
    .replace(LINK_STYLESHEET_TAG_RE, '')
    .replace(SCRIPT_BLOCK_RE, '')
    .replace(SCRIPT_SELFCLOSE_RE, '');

  // 2. Inline every .css file as a <style> block, in document (key) order.
  const cssBlocks = Object.keys(files)
    .filter((path) => fileExtension(path) === '.css')
    .map((path) => `<style data-relay-view-css="${escapeAttribute(path)}">\n${files[path] ?? ''}\n</style>`)
    .join('\n');

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${AGENT_VIEW_CSP}">`;
  const headInjection = `${cspMeta}${cssBlocks ? `\n${cssBlocks}` : ''}`;

  // 3. Inject CSP meta + styles into <head>, or wrap the document if absent.
  if (HEAD_OPEN_RE.test(entryHtml)) {
    return entryHtml.replace(HEAD_OPEN_RE, (match) => `${match}\n${headInjection}`);
  }
  if (HTML_OPEN_RE.test(entryHtml)) {
    return entryHtml.replace(
      HTML_OPEN_RE,
      (match) => `${match}\n<head>\n${headInjection}\n</head>`
    );
  }
  return `<!doctype html>\n<html>\n<head>\n${headInjection}\n</head>\n<body>\n${entryHtml}\n</body>\n</html>`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
