import type {
  RelayCliGatewayCommand,
  RelayJsonSchema,
} from './cli-gateway-contract.js';
import {
  relayCommandDefinitionsForSurface,
  type RelayCommandControlRequirement,
  type RelayCommandDefinition,
  type RelayCommandScopeKind,
  type RelayCommandSideEffect,
} from './relay-command-manifest.js';
import {
  relayActionDescriptorFromCommandDefinition,
  type RelayActionDescriptor,
  type RelayActionSurface,
} from './action-descriptor.js';
import type { RelayCapabilityBit } from './security-policy.js';

export interface CommandCenterResolverCatalogEntry {
  commandId: RelayCliGatewayCommand;
  label: string;
  summary: string;
  keywords: readonly string[];
  sideEffect: RelayCommandSideEffect;
  requiresConfirmation: boolean;
  controlRequirements: readonly RelayCommandControlRequirement[];
  scopeKinds: readonly RelayCommandScopeKind[];
  capabilityHints: readonly RelayCapabilityBit[];
  surfaces: readonly RelayActionSurface[];
  ui?: {
    actionId?: string;
    category?: string;
  };
  inputSchema: RelayJsonSchema;
}

export interface CommandCenterResolverCatalog {
  entries: readonly CommandCenterResolverCatalogEntry[];
  byCommandId: ReadonlyMap<
    RelayCliGatewayCommand,
    CommandCenterResolverCatalogEntry
  >;
}

export interface CommandCenterResolverSearchHit {
  entry: CommandCenterResolverCatalogEntry;
  score: number;
}

export interface CommandCenterProviderIntent {
  commandId: string;
  args?: unknown;
  confidence: number;
  rationale?: string;
  sideEffect?: string;
  requiresConfirmation?: boolean;
  scopeKinds?: readonly string[];
  capabilityHints?: readonly string[];
  surfaces?: readonly string[];
  ui?: {
    actionId?: string;
    category?: string;
  };
}

export interface CommandCenterResolvedIntent {
  commandId: RelayCliGatewayCommand;
  args: Record<string, unknown>;
  confidence: number;
  rationale?: string;
  sideEffect: RelayCommandSideEffect;
  requiresConfirmation: boolean;
  controlRequirements: readonly RelayCommandControlRequirement[];
  scopeKinds: readonly RelayCommandScopeKind[];
  capabilityHints: readonly RelayCapabilityBit[];
  surfaces: readonly RelayActionSurface[];
  ui?: {
    actionId?: string;
    category?: string;
  };
}

export type CommandCenterFallbackReason =
  | 'provider-missing'
  | 'provider-unhealthy'
  | 'timeout'
  | 'provider-error'
  | 'malformed-output'
  | 'low-confidence'
  | 'unknown-command'
  | 'invalid-args'
  | 'metadata-mismatch';

export type CommandCenterResolution =
  | {
      kind: 'resolved';
      intent: CommandCenterResolvedIntent;
      entry: CommandCenterResolverCatalogEntry;
      suggestions: readonly CommandCenterResolverSearchHit[];
    }
  | {
      kind: 'fallback';
      reason: CommandCenterFallbackReason;
      detail?: string;
      suggestions: readonly CommandCenterResolverSearchHit[];
    };

export interface ValidateProviderIntentOptions {
  catalog?: CommandCenterResolverCatalog;
  minConfidence?: number;
  query?: string;
  suggestionLimit?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.6;
const WORD_SPLIT = /[^a-z0-9]+/i;
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'and',
  'or',
  'with',
  'command',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(WORD_SPLIT)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function keywordsForDescriptor(descriptor: RelayActionDescriptor): string[] {
  return uniqueStrings([
    ...tokenize(descriptor.id),
    ...tokenize(descriptor.label),
    ...tokenize(descriptor.title),
    ...tokenize(descriptor.description ?? ''),
    ...(descriptor.ui?.aliases?.flatMap(tokenize) ?? []),
    ...(descriptor.contract?.cli?.flatMap(tokenize) ?? []),
  ]);
}

export function catalogEntryFromActionDescriptor(
  descriptor: RelayActionDescriptor
): CommandCenterResolverCatalogEntry | null {
  if (!descriptor.contract) return null;
  if (descriptor.input.kind !== 'json-schema') return null;
  if (descriptor.sideEffect === 'ui') return null;

  return {
    commandId: descriptor.contract.relayCommandName,
    label: descriptor.label,
    summary: descriptor.description ?? descriptor.label,
    keywords: keywordsForDescriptor(descriptor),
    sideEffect: descriptor.sideEffect,
    requiresConfirmation: descriptor.confirmation.required,
    controlRequirements: descriptor.confirmation.controlRequirements,
    scopeKinds: scopeKindsFromDescriptor(descriptor),
    capabilityHints:
      descriptor.availability.capabilityHints ??
      ([] as readonly RelayCapabilityBit[]),
    surfaces: descriptor.surfaces,
    ...(descriptor.ui
      ? {
          ui: {
            ...(descriptor.ui.actionId
              ? { actionId: descriptor.ui.actionId }
              : {}),
            ...(descriptor.ui.category
              ? { category: descriptor.ui.category }
              : {}),
          },
        }
      : {}),
    inputSchema: descriptor.input.schema,
  };
}

function scopeKindsFromDescriptor(
  descriptor: RelayActionDescriptor
): readonly RelayCommandScopeKind[] {
  const command = relayCommandDefinitionsForSurface('web').find(
    (entry) => entry.name === descriptor.contract?.relayCommandName
  );
  return command?.scopeKinds ?? [];
}

export function buildCommandCenterResolverCatalog(
  descriptors: readonly RelayActionDescriptor[] = relayCommandDefinitionsForSurface(
    'web'
  ).map((definition) =>
    relayActionDescriptorFromCommandDefinition(definition, {
      surfaces: [...definition.surfaces, 'command-center'],
    })
  )
): CommandCenterResolverCatalog {
  const entries = descriptors
    .map(catalogEntryFromActionDescriptor)
    .filter(
      (entry): entry is CommandCenterResolverCatalogEntry => entry !== null
    );
  const byCommandId = new Map<
    RelayCliGatewayCommand,
    CommandCenterResolverCatalogEntry
  >();
  entries.forEach((entry) => byCommandId.set(entry.commandId, entry));
  return { entries, byCommandId };
}

export function commandCenterDescriptorFromCommandDefinition(
  definition: RelayCommandDefinition
): RelayActionDescriptor {
  return relayActionDescriptorFromCommandDefinition(definition, {
    surfaces: [...definition.surfaces, 'command-center'],
  });
}

export const COMMAND_CENTER_RESOLVER_CATALOG: CommandCenterResolverCatalog =
  buildCommandCenterResolverCatalog();

export function searchCommandCenterCatalog(
  query: string,
  catalog: CommandCenterResolverCatalog = COMMAND_CENTER_RESOLVER_CATALOG,
  limit = 8
): CommandCenterResolverSearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const hits: CommandCenterResolverSearchHit[] = [];
  for (const entry of catalog.entries) {
    const score = scoreCatalogEntry(entry, terms);
    if (score > 0) hits.push({ entry, score });
  }

  return hits
    .sort(
      (a, b) =>
        b.score - a.score || a.entry.commandId.localeCompare(b.entry.commandId)
    )
    .slice(0, limit);
}

function scoreCatalogEntry(
  entry: CommandCenterResolverCatalogEntry,
  terms: readonly string[]
): number {
  let score = 0;
  for (const term of terms) {
    if (entry.commandId.toLowerCase().includes(term)) score += 4;
    if (entry.keywords.includes(term)) score += 2;
    else if (entry.keywords.some((keyword) => keyword.startsWith(term)))
      score += 1;
  }
  return score;
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value: unknown, type: string): boolean {
  const actual = jsonType(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return jsonType(value) === 'object';
}

export function validateCommandCenterArgs(
  value: unknown,
  schema: RelayJsonSchema,
  path = '$'
): string[] {
  const errors: string[] = [];

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const`);
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    errors.push(`${path}: not in enum`);
  }
  errors.push(...validateSchemaType(value, schema, path));
  if (errors.length > 0) return errors;

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: below minimum`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: above maximum`);
    }
  }

  errors.push(...validateSchemaObject(value, schema, path));
  errors.push(...validateSchemaArray(value, schema, path));
  errors.push(...validateSchemaBranches(value, schema, path));

  return errors;
}

function validateSchemaType(
  value: unknown,
  schema: RelayJsonSchema,
  path: string
): string[] {
  if (schema.type === undefined) return [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((type) => typeMatches(value, type))) return [];
  return [`${path}: expected ${types.join('|')}, got ${jsonType(value)}`];
}

function validateSchemaObject(
  value: unknown,
  schema: RelayJsonSchema,
  path: string
): string[] {
  if (
    !schema.properties &&
    !schema.required &&
    schema.additionalProperties !== false
  ) {
    return [];
  }
  if (!isPlainObject(value)) return [`${path}: expected object`];

  const errors: string[] = [];
  const properties = schema.properties ?? {};
  for (const requiredKey of schema.required ?? []) {
    if (!(requiredKey in value))
      errors.push(`${path}.${requiredKey}: required`);
  }
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key];
    if (childSchema) {
      errors.push(
        ...validateCommandCenterArgs(child, childSchema, `${path}.${key}`)
      );
    } else if (schema.additionalProperties === false) {
      errors.push(`${path}.${key}: unknown property`);
    }
  }
  return errors;
}

function validateSchemaArray(
  value: unknown,
  schema: RelayJsonSchema,
  path: string
): string[] {
  if (!schema.items || !Array.isArray(value)) return [];
  return value.flatMap((item, index) =>
    validateCommandCenterArgs(
      item,
      schema.items as RelayJsonSchema,
      `${path}[${index}]`
    )
  );
}

function validateSchemaBranches(
  value: unknown,
  schema: RelayJsonSchema,
  path: string
): string[] {
  const errors: string[] = [];
  if (schema.anyOf?.length) {
    const matched = schema.anyOf.some(
      (branch) => validateCommandCenterArgs(value, branch, path).length === 0
    );
    if (!matched) errors.push(`${path}: did not match anyOf`);
  }
  if (schema.oneOf?.length) {
    const matches = schema.oneOf.filter(
      (branch) => validateCommandCenterArgs(value, branch, path).length === 0
    ).length;
    if (matches !== 1) errors.push(`${path}: did not match exactly one oneOf`);
  }
  return errors;
}

function sameStringSet(
  declared: readonly string[] | undefined,
  canonical: readonly string[]
): boolean {
  if (declared === undefined) return true;
  const declaredSet = new Set(declared);
  const canonicalSet = new Set(canonical);
  if (declaredSet.size !== canonicalSet.size) return false;
  for (const value of Array.from(declaredSet)) {
    if (!canonicalSet.has(value)) return false;
  }
  return true;
}

function uiMetadataMatches(
  declared: CommandCenterProviderIntent['ui'],
  entry: CommandCenterResolverCatalogEntry
): boolean {
  if (!declared) return true;
  return (
    (declared.actionId === undefined ||
      declared.actionId === entry.ui?.actionId) &&
    (declared.category === undefined ||
      declared.category === entry.ui?.category)
  );
}

function metadataMatches(
  claim: CommandCenterProviderIntent,
  entry: CommandCenterResolverCatalogEntry
): boolean {
  return (
    (claim.sideEffect === undefined || claim.sideEffect === entry.sideEffect) &&
    (claim.requiresConfirmation === undefined ||
      claim.requiresConfirmation === entry.requiresConfirmation) &&
    sameStringSet(claim.scopeKinds, entry.scopeKinds) &&
    sameStringSet(claim.capabilityHints, entry.capabilityHints) &&
    sameStringSet(claim.surfaces, entry.surfaces) &&
    uiMetadataMatches(claim.ui, entry)
  );
}

function fallback(
  reason: CommandCenterFallbackReason,
  suggestions: readonly CommandCenterResolverSearchHit[],
  detail?: string
): CommandCenterResolution {
  return {
    kind: 'fallback',
    reason,
    ...(detail ? { detail } : {}),
    suggestions,
  };
}

export function validateCommandCenterProviderIntent(
  raw: unknown,
  options: ValidateProviderIntentOptions = {}
): CommandCenterResolution {
  const catalog = options.catalog ?? COMMAND_CENTER_RESOLVER_CATALOG;
  const suggestions = options.query
    ? searchCommandCenterCatalog(
        options.query,
        catalog,
        options.suggestionLimit
      )
    : [];
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  if (!isPlainObject(raw)) {
    return fallback(
      'malformed-output',
      suggestions,
      'provider output is not an object'
    );
  }
  const claim = raw as unknown as CommandCenterProviderIntent;
  if (typeof claim.commandId !== 'string') {
    return fallback('malformed-output', suggestions, 'missing commandId');
  }
  if (
    typeof claim.confidence !== 'number' ||
    !Number.isFinite(claim.confidence)
  ) {
    return fallback('malformed-output', suggestions, 'missing confidence');
  }

  const entry = catalog.byCommandId.get(
    claim.commandId as RelayCliGatewayCommand
  );
  if (!entry) return fallback('unknown-command', suggestions);
  if (claim.confidence < minConfidence)
    return fallback('low-confidence', suggestions);

  const args = claim.args ?? {};
  if (!isPlainObject(args)) return fallback('invalid-args', suggestions);
  const argErrors = validateCommandCenterArgs(args, entry.inputSchema);
  if (argErrors.length > 0) {
    return fallback(
      'invalid-args',
      suggestions,
      argErrors.slice(0, 3).join('; ')
    );
  }
  if (!metadataMatches(claim, entry))
    return fallback('metadata-mismatch', suggestions);

  return {
    kind: 'resolved',
    entry,
    suggestions,
    intent: {
      commandId: entry.commandId,
      args,
      confidence: claim.confidence,
      ...(typeof claim.rationale === 'string'
        ? { rationale: claim.rationale }
        : {}),
      sideEffect: entry.sideEffect,
      requiresConfirmation: entry.requiresConfirmation,
      controlRequirements: entry.controlRequirements,
      scopeKinds: entry.scopeKinds,
      capabilityHints: entry.capabilityHints,
      surfaces: entry.surfaces,
      ...(entry.ui ? { ui: entry.ui } : {}),
    },
  };
}

export function summarizeCommandCenterCatalogForResolver(
  catalog: CommandCenterResolverCatalog = COMMAND_CENTER_RESOLVER_CATALOG
): Array<{
  commandId: RelayCliGatewayCommand;
  label: string;
  summary: string;
  sideEffect: RelayCommandSideEffect;
  requiresConfirmation: boolean;
  inputSchema: RelayJsonSchema;
}> {
  return catalog.entries.map((entry) => ({
    commandId: entry.commandId,
    label: entry.label,
    summary: entry.summary,
    sideEffect: entry.sideEffect,
    requiresConfirmation: entry.requiresConfirmation,
    inputSchema: entry.inputSchema,
  }));
}
