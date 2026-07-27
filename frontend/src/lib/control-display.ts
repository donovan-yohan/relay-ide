import type {
  ControlActor,
  InterventionRecord,
} from '../../../shared/control-state.js';

export function actorLabel(actor: ControlActor | null | undefined): string {
  if (!actor) return 'none';
  return actor.displayName ?? actor.id ?? actor.kind;
}

export function formatControlTimestamp(
  value: string | null | undefined
): string {
  if (!value) return 'none';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

export function interventionLabel(record: InterventionRecord): string {
  if (record.kind === 'human-input') return 'input';
  if (record.kind === 'supervisor-send-text') return 'sent text';
  if (record.kind === 'supervisor-send-key') return 'sent key';
  return 'submitted';
}

export function interventionTitle(record: InterventionRecord): string {
  const parts = [
    `${interventionLabel(record)} by ${actorLabel(record.author)}`,
    `at ${formatControlTimestamp(record.timestamp)}`,
  ];
  if (record.payloadPreview) parts.push(`preview: ${record.payloadPreview}`);
  if (record.redaction.redacted) parts.push('payload redacted');
  return parts.join('\n');
}

export function mergeInterventions(
  primary: InterventionRecord[],
  secondary: InterventionRecord[]
): InterventionRecord[] {
  const byId = new Map<string, InterventionRecord>();
  for (const record of [...primary, ...secondary]) byId.set(record.id, record);
  return Array.from(byId.values()).sort((a, b) => {
    const bTime = Date.parse(b.timestamp);
    const aTime = Date.parse(a.timestamp);
    return (
      (Number.isFinite(bTime) ? bTime : 0) -
      (Number.isFinite(aTime) ? aTime : 0)
    );
  });
}
