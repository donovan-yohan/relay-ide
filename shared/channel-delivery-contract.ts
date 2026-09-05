import path from 'node:path';

export type ChannelDeliveryExpectation =
  | { kind: 'pr'; branch?: string }
  | { kind: 'commit' }
  | { kind: 'file'; path: string }
  | { kind: 'text'; regex: string };

export interface ChannelDeliveryContract {
  /** Original string specs as declared by the caller. */
  expect: string[];
  /** Parsed, validated specs. */
  parsed: ChannelDeliveryExpectation[];
}

export class ChannelDeliveryContractParseError extends Error {
  constructor(
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ChannelDeliveryContractParseError';
  }
}

function cleanSpec(spec: string): string {
  return spec.trim();
}

function ensureNonEmpty(value: string, label: string, spec: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ChannelDeliveryContractParseError(`${label} must be non-empty`, {
      spec,
      label,
    });
  }
  return trimmed;
}

export function parseChannelDeliveryExpectation(
  rawSpec: string
): ChannelDeliveryExpectation {
  const spec = cleanSpec(rawSpec);
  if (!spec) {
    throw new ChannelDeliveryContractParseError(
      'expect spec must be non-empty',
      {
        spec: rawSpec,
      }
    );
  }
  if (spec === 'commit') return { kind: 'commit' };
  if (spec === 'pr') return { kind: 'pr' };
  if (spec.startsWith('pr:')) {
    const branch = ensureNonEmpty(spec.slice('pr:'.length), 'pr branch', spec);
    return { kind: 'pr', branch };
  }
  if (spec.startsWith('file:')) {
    const rel = ensureNonEmpty(spec.slice('file:'.length), 'file path', spec);
    if (path.isAbsolute(rel)) {
      throw new ChannelDeliveryContractParseError(
        'file path must be relative to the routing cwd',
        { spec, path: rel }
      );
    }
    // Normalize purely for stable equality; the evaluator still joins against cwd.
    const normalized = path.normalize(rel);
    if (!normalized || normalized === '.' || normalized === path.sep) {
      throw new ChannelDeliveryContractParseError(
        'file path must be a non-empty relative path',
        { spec, path: rel }
      );
    }
    return { kind: 'file', path: normalized };
  }
  if (spec.startsWith('text:')) {
    const pattern = ensureNonEmpty(
      spec.slice('text:'.length),
      'text regex',
      spec
    );
    try {
      // Validate compilation. We store the source string, not the RegExp instance.
      // Default flags are caller-controlled by embedding in the pattern itself.
      // (Callers that want flags can use `(?m)` etc.)

      new RegExp(pattern);
    } catch (err) {
      throw new ChannelDeliveryContractParseError('text regex is invalid', {
        spec,
        regex: pattern,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { kind: 'text', regex: pattern };
  }
  const kind = spec.split(':', 1)[0] ?? spec;
  throw new ChannelDeliveryContractParseError('unknown expect spec kind', {
    spec,
    kind,
    allowed: ['pr', 'pr:<branch>', 'commit', 'file:<path>', 'text:<regex>'],
  });
}

export function parseChannelDeliveryContract(
  expect: readonly string[] | undefined
): ChannelDeliveryContract | null {
  if (!expect || expect.length === 0) return null;
  const cleaned = expect.map((s) => String(s)).map(cleanSpec);
  if (cleaned.some((s) => !s)) {
    throw new ChannelDeliveryContractParseError(
      'expect specs must be non-empty strings',
      {
        expect,
      }
    );
  }
  const parsed = cleaned.map(parseChannelDeliveryExpectation);
  return { expect: cleaned, parsed };
}
