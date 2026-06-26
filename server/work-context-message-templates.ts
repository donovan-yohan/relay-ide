import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { WorkContextStore } from './work-contexts.js';
import type { WorkContextMessageCreateInput } from '../shared/work-context-message.js';

const TEMPLATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_STRING_CHARS = 4000;
const MAX_GUIDE_DEPTH = 20;
const TEMPLATE_DIR = path.join('.relay', 'messages');

const gitChildEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
};

export type WorkContextMessageTemplateEncoding =
  | 'json'
  | 'markdown'
  | 'text'
  | 'artifact-ref';
export type WorkContextMessageTemplateDiagnosticCode =
  | 'no-repo'
  | 'missing-dir'
  | 'invalid-selector'
  | 'invalid-template-name'
  | 'template-not-found'
  | 'duplicate-template-id'
  | 'template-invalid';

export interface WorkContextMessageTemplateDiagnostic {
  code: WorkContextMessageTemplateDiagnosticCode;
  message: string;
  template?: string;
  sourcePath?: string;
}

export interface WorkContextMessageTemplateFallback {
  kind?: string;
  payloadSchema?: string;
  mediaType?: string;
  encoding?: WorkContextMessageTemplateEncoding;
  bodyGuide?: unknown;
}

export interface WorkContextMessageTemplate {
  schemaVersion: 1;
  id: string;
  stem: string;
  name: string;
  description?: string;
  kind: string;
  payloadSchema: string;
  mediaType: string;
  encoding: WorkContextMessageTemplateEncoding;
  bodyGuide?: unknown;
  example?: {
    summary?: string;
    payload?: {
      body?: unknown;
      artifactRefs?: Array<{
        id: string;
        kind?: string;
        uri?: string;
        title?: string;
      }>;
    };
    refs?: unknown;
  };
  fallback?: WorkContextMessageTemplateFallback;
  tags?: string[];
  sourcePath: string;
}

export interface WorkContextMessageTemplateSelector {
  repoPath?: string;
  cwd?: string;
  workContextId?: string;
}

export interface WorkContextMessageTemplateListResult {
  repoRoot?: string;
  templateDir?: string;
  templates: WorkContextMessageTemplate[];
  diagnostics: WorkContextMessageTemplateDiagnostic[];
}

export interface WorkContextMessageTemplateRenderInput extends WorkContextMessageTemplateSelector {
  template?: string;
  templateData?: unknown;
  message?: Record<string, unknown>;
}

export interface WorkContextMessageTemplateRenderResult {
  template: WorkContextMessageTemplate;
  messageInput: Record<string, unknown>;
  diagnostics: WorkContextMessageTemplateDiagnostic[];
}

export class WorkContextMessageTemplateError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: WorkContextMessageTemplateDiagnosticCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'WorkContextMessageTemplateError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanBoundedString(value: unknown, field: string): string {
  const text = readString(value);
  if (!text) throw new Error(`${field} is required`);
  if (text.length > MAX_STRING_CHARS) throw new Error(`${field} is too long`);
  return text;
}

function cleanOptionalString(
  value: unknown,
  field: string
): string | undefined {
  const text = readString(value);
  if (!text) return undefined;
  if (text.length > MAX_STRING_CHARS) throw new Error(`${field} is too long`);
  return text;
}

function assertJsonDepth(value: unknown, field: string, depth = 0): void {
  if (depth > MAX_GUIDE_DEPTH) throw new Error(`${field} is too deeply nested`);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonDepth(item, field, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value))
      assertJsonDepth(item, field, depth + 1);
  }
}

function cleanEncoding(value: unknown): WorkContextMessageTemplateEncoding {
  const encoding = cleanBoundedString(value, 'encoding');
  if (!['json', 'markdown', 'text', 'artifact-ref'].includes(encoding)) {
    throw new Error('encoding is invalid');
  }
  return encoding as WorkContextMessageTemplateEncoding;
}

function cleanTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('tags must be an array');
  const tags = value.flatMap((item) => {
    const text = readString(item);
    return text ? [text.slice(0, 80)] : [];
  });
  return tags.length ? tags.slice(0, 20) : undefined;
}

function cleanFallback(
  value: unknown
): WorkContextMessageTemplateFallback | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('fallback must be an object');
  if (value['bodyGuide'] !== undefined)
    assertJsonDepth(value['bodyGuide'], 'fallback.bodyGuide');
  const fallback: WorkContextMessageTemplateFallback = {};
  const kind = cleanOptionalString(value['kind'], 'fallback.kind');
  if (kind) fallback.kind = kind;
  const payloadSchema = cleanOptionalString(
    value['payloadSchema'],
    'fallback.payloadSchema'
  );
  if (payloadSchema) fallback.payloadSchema = payloadSchema;
  const mediaType = cleanOptionalString(
    value['mediaType'],
    'fallback.mediaType'
  );
  if (mediaType) fallback.mediaType = mediaType;
  if (value['encoding'] !== undefined)
    fallback.encoding = cleanEncoding(value['encoding']);
  if (value['bodyGuide'] !== undefined) fallback.bodyGuide = value['bodyGuide'];
  return fallback;
}

function cleanExample(
  value: unknown
): WorkContextMessageTemplate['example'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('example must be an object');
  assertJsonDepth(value, 'example');
  const example: NonNullable<WorkContextMessageTemplate['example']> = {};
  const summary = cleanOptionalString(value['summary'], 'example.summary');
  if (summary) example.summary = summary;
  const payload = isRecord(value['payload']) ? value['payload'] : undefined;
  if (payload) {
    const payloadOut: NonNullable<
      NonNullable<WorkContextMessageTemplate['example']>['payload']
    > = {};
    if (payload['body'] !== undefined) payloadOut.body = payload['body'];
    if (Array.isArray(payload['artifactRefs'])) {
      const artifactRefs = payload['artifactRefs'].flatMap((item) => {
        if (!isRecord(item)) return [];
        const id = readString(item['id']);
        if (!id) return [];
        const ref: { id: string; kind?: string; uri?: string; title?: string } =
          { id };
        const kind = readString(item['kind']);
        if (kind) ref.kind = kind;
        const uri = readString(item['uri']);
        if (uri) ref.uri = uri;
        const title = readString(item['title']);
        if (title) ref.title = title;
        return [ref];
      });
      if (artifactRefs.length) payloadOut.artifactRefs = artifactRefs;
    }
    if (Object.keys(payloadOut).length > 0) example.payload = payloadOut;
  }
  if (value['refs'] !== undefined) example.refs = value['refs'];
  return example;
}

function parseTemplate(
  raw: unknown,
  sourcePath: string,
  stem: string
): WorkContextMessageTemplate {
  if (!isRecord(raw)) throw new Error('template must be a JSON object');
  if (raw['schemaVersion'] !== 1) throw new Error('schemaVersion must be 1');
  if (raw['bodyGuide'] !== undefined)
    assertJsonDepth(raw['bodyGuide'], 'bodyGuide');
  const template: WorkContextMessageTemplate = {
    schemaVersion: 1,
    id: cleanBoundedString(raw['id'], 'id'),
    stem,
    name: cleanBoundedString(raw['name'], 'name'),
    kind: cleanBoundedString(raw['kind'], 'kind'),
    payloadSchema: cleanBoundedString(raw['payloadSchema'], 'payloadSchema'),
    mediaType: cleanBoundedString(raw['mediaType'], 'mediaType'),
    encoding: cleanEncoding(raw['encoding']),
    sourcePath,
  };
  const description = cleanOptionalString(raw['description'], 'description');
  if (description) template.description = description;
  if (raw['bodyGuide'] !== undefined) template.bodyGuide = raw['bodyGuide'];
  const example = cleanExample(raw['example']);
  if (example) template.example = example;
  const fallback = cleanFallback(raw['fallback']);
  if (fallback) template.fallback = fallback;
  const tags = cleanTags(raw['tags']);
  if (tags) template.tags = tags;
  return template;
}

function diagnostic(
  code: WorkContextMessageTemplateDiagnosticCode,
  message: string,
  extra: Omit<WorkContextMessageTemplateDiagnostic, 'code' | 'message'> = {}
): WorkContextMessageTemplateDiagnostic {
  return { code, message, ...extra };
}

function repoPathFromWorkContext(
  workContextStore: WorkContextStore | undefined,
  workContextId: string | undefined
): string | undefined {
  if (!workContextId || !workContextStore) return undefined;
  const context = workContextStore.get(workContextId);
  return (
    context?.anchors.worktree?.localPath ?? context?.anchors.repo?.localPath
  );
}

function selectorPath(
  selector: WorkContextMessageTemplateSelector,
  workContextStore?: WorkContextStore
): string | undefined {
  return (
    selector.repoPath ??
    selector.cwd ??
    repoPathFromWorkContext(workContextStore, selector.workContextId) ??
    process.cwd()
  );
}

function resolveRepoRoot(
  selector: WorkContextMessageTemplateSelector,
  workContextStore?: WorkContextStore
): {
  repoRoot?: string;
  selectedDir?: string;
  diagnostics: WorkContextMessageTemplateDiagnostic[];
} {
  const selectedPath = selectorPath(selector, workContextStore);
  if (!selectedPath)
    return {
      diagnostics: [diagnostic('no-repo', 'no repo selector provided')],
    };
  try {
    const realSelected = fs.realpathSync(path.resolve(selectedPath));
    const stat = fs.lstatSync(realSelected);
    if (!stat.isDirectory()) {
      return {
        diagnostics: [
          diagnostic(
            'invalid-selector',
            'template selector must resolve to a directory',
            { sourcePath: realSelected }
          ),
        ],
      };
    }
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: realSelected,
      env: gitChildEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return {
      repoRoot: fs.realpathSync(repoRoot),
      selectedDir: realSelected,
      diagnostics: [],
    };
  } catch {
    return {
      diagnostics: [
        diagnostic(
          'no-repo',
          'no git repository found for template discovery',
          { sourcePath: path.resolve(selectedPath) }
        ),
      ],
    };
  }
}

function templateDirForRepo(repoRoot: string): string {
  return path.join(repoRoot, TEMPLATE_DIR);
}

function templateDirsForSelection(
  repoRoot: string,
  selectedDir: string | undefined
): string[] {
  const dirs: string[] = [];
  let current =
    selectedDir && selectedDir.startsWith(repoRoot) ? selectedDir : repoRoot;
  while (current.startsWith(repoRoot)) {
    dirs.push(path.join(current, TEMPLATE_DIR));
    if (current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

function safeStem(filename: string): string | undefined {
  if (!filename.endsWith('.json')) return undefined;
  const stem = filename.slice(0, -'.json'.length);
  return TEMPLATE_NAME_RE.test(stem) ? stem : undefined;
}

function readTemplatesFromDir(
  repoRoot: string,
  candidateDir: string,
  includeInvalid: boolean | undefined,
  diagnostics: WorkContextMessageTemplateDiagnostic[]
): WorkContextMessageTemplate[] {
  if (!fs.existsSync(candidateDir)) return [];
  const realDir = fs.realpathSync(candidateDir);
  if (realDir !== repoRoot && !realDir.startsWith(`${repoRoot}${path.sep}`)) {
    diagnostics.push(
      diagnostic('invalid-selector', 'template directory escapes repo root', {
        sourcePath: realDir,
      })
    );
    return [];
  }
  const idsInDir = new Set<string>();
  return fs
    .readdirSync(realDir)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((filename) =>
      readTemplateFromDirEntry(
        realDir,
        filename,
        includeInvalid,
        diagnostics,
        idsInDir
      )
    );
}

function readTemplateFromDirEntry(
  realDir: string,
  filename: string,
  includeInvalid: boolean | undefined,
  diagnostics: WorkContextMessageTemplateDiagnostic[],
  idsInDir: Set<string>
): WorkContextMessageTemplate[] {
  const stem = safeStem(filename);
  const sourcePath = path.join(realDir, filename);
  if (!stem) {
    if (filename.endsWith('.json') || includeInvalid) {
      diagnostics.push(
        diagnostic('invalid-template-name', 'template filename is invalid', {
          template: filename,
          sourcePath,
        })
      );
    }
    return [];
  }
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('template must be a regular file');
    if (stat.size > MAX_TEMPLATE_BYTES)
      throw new Error('template file is too large');
    const realFile = fs.realpathSync(sourcePath);
    if (!realFile.startsWith(`${realDir}${path.sep}`))
      throw new Error('template path escapes template directory');
    const template = parseTemplate(
      JSON.parse(fs.readFileSync(realFile, 'utf8')),
      realFile,
      stem
    );
    if (idsInDir.has(template.id)) {
      diagnostics.push(
        diagnostic(
          'duplicate-template-id',
          'duplicate template id in one directory; first lexicographic file wins for that directory',
          { template: template.id, sourcePath: realFile }
        )
      );
      return [];
    }
    idsInDir.add(template.id);
    return [template];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(
      diagnostic('template-invalid', message, { template: stem, sourcePath })
    );
    return [];
  }
}

export function listWorkContextMessageTemplates(
  selector: WorkContextMessageTemplateSelector,
  options: {
    workContextStore?: WorkContextStore;
    includeInvalid?: boolean;
  } = {}
): WorkContextMessageTemplateListResult {
  const { repoRoot, selectedDir, diagnostics } = resolveRepoRoot(
    selector,
    options.workContextStore
  );
  if (!repoRoot) return { templates: [], diagnostics };
  const templateDir = templateDirForRepo(repoRoot);
  const templateDirs = templateDirsForSelection(repoRoot, selectedDir);
  if (!templateDirs.some((dir) => fs.existsSync(dir))) {
    return {
      repoRoot,
      templateDir,
      templates: [],
      diagnostics: [
        diagnostic(
          'missing-dir',
          'repo has no .relay/messages template directory',
          { sourcePath: templateDir }
        ),
      ],
    };
  }
  const templatesById = new Map<string, WorkContextMessageTemplate>();
  for (const candidateDir of templateDirs) {
    for (const template of readTemplatesFromDir(
      repoRoot,
      candidateDir,
      options.includeInvalid,
      diagnostics
    )) {
      templatesById.set(template.id, template);
    }
  }
  const templates = Array.from(templatesById.values()).sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  return {
    repoRoot,
    templateDir,
    templates,
    diagnostics: options.includeInvalid
      ? diagnostics
      : diagnostics.filter((entry) => entry.code !== 'template-invalid'),
  };
}

export function findWorkContextMessageTemplate(
  selector: WorkContextMessageTemplateSelector,
  templateIdOrStem: string,
  options: { workContextStore?: WorkContextStore } = {}
): {
  template: WorkContextMessageTemplate;
  diagnostics: WorkContextMessageTemplateDiagnostic[];
  repoRoot?: string;
  templateDir?: string;
} {
  if (
    !TEMPLATE_NAME_RE.test(templateIdOrStem) &&
    templateIdOrStem.includes('/')
  ) {
    throw new WorkContextMessageTemplateError(
      400,
      'invalid-template-name',
      'template id or stem is invalid',
      { template: templateIdOrStem }
    );
  }
  const listed = listWorkContextMessageTemplates(selector, {
    ...(options.workContextStore
      ? { workContextStore: options.workContextStore }
      : {}),
    includeInvalid: true,
  });
  const byId = listed.templates.filter(
    (entry) => entry.id === templateIdOrStem
  );
  if (byId.length > 1) {
    throw new WorkContextMessageTemplateError(
      409,
      'duplicate-template-id',
      'duplicate template id requires filename-stem lookup',
      { template: templateIdOrStem }
    );
  }
  const template =
    byId[0] ??
    listed.templates.find((entry) => entry.stem === templateIdOrStem);
  if (!template) {
    throw new WorkContextMessageTemplateError(
      404,
      'template-not-found',
      'WorkContext message template not found',
      { template: templateIdOrStem }
    );
  }
  const result: {
    template: WorkContextMessageTemplate;
    diagnostics: WorkContextMessageTemplateDiagnostic[];
    repoRoot?: string;
    templateDir?: string;
  } = { template, diagnostics: listed.diagnostics };
  if (listed.repoRoot) result.repoRoot = listed.repoRoot;
  if (listed.templateDir) result.templateDir = listed.templateDir;
  return result;
}

export function renderWorkContextMessageTemplate(
  input: WorkContextMessageTemplateRenderInput,
  options: { workContextStore?: WorkContextStore } = {}
): WorkContextMessageTemplateRenderResult {
  const templateId = input.template;
  if (!templateId) {
    throw new WorkContextMessageTemplateError(
      400,
      'template-not-found',
      'template is required'
    );
  }
  const { template, diagnostics } = findWorkContextMessageTemplate(
    input,
    templateId,
    options
  );
  const messageInput: Record<string, unknown> = { ...(input.message ?? {}) };
  if (messageInput['kind'] === undefined) messageInput['kind'] = template.kind;
  if (messageInput['payloadSchema'] === undefined)
    messageInput['payloadSchema'] = template.payloadSchema;
  const payload = isRecord(messageInput['payload'])
    ? { ...messageInput['payload'] }
    : {};
  if (payload['mediaType'] === undefined)
    payload['mediaType'] = template.mediaType;
  if (payload['encoding'] === undefined)
    payload['encoding'] = template.encoding;
  if (payload['body'] === undefined && input.templateData !== undefined)
    payload['body'] = input.templateData;
  if (Object.keys(payload).length > 0) messageInput['payload'] = payload;
  return { template, messageInput, diagnostics };
}

export function applyWorkContextMessageTemplateToAppendInput(
  rawInput: Record<string, unknown>,
  options: { workContextStore?: WorkContextStore } = {}
): {
  input: WorkContextMessageCreateInput | Record<string, unknown>;
  template?: WorkContextMessageTemplate;
  diagnostics: WorkContextMessageTemplateDiagnostic[];
} {
  const template = readString(rawInput['template']);
  if (!template) return { input: rawInput, diagnostics: [] };
  const repoPath = readString(rawInput['repoPath']);
  const cwd = readString(rawInput['cwd']);
  const workContextId = readString(rawInput['workContextId']);
  const render = renderWorkContextMessageTemplate(
    {
      ...(repoPath ? { repoPath } : {}),
      ...(cwd ? { cwd } : {}),
      ...(workContextId ? { workContextId } : {}),
      template,
      templateData: rawInput['templateData'],
      message: rawInput,
    },
    options
  );
  delete render.messageInput['template'];
  delete render.messageInput['templateData'];
  delete render.messageInput['repoPath'];
  delete render.messageInput['cwd'];
  return {
    input: render.messageInput,
    template: render.template,
    diagnostics: render.diagnostics,
  };
}
